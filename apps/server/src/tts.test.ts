import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const elevenLabsTestState = vi.hoisted(() => ({
  streamCalls: [] as { voiceId: string; text: string }[],
}));
vi.mock("@elevenlabs/elevenlabs-js", () => ({
  ElevenLabsClient: class {
    textToSpeech = {
      stream: vi.fn(async (voiceId: string, options: { text: string }) => {
        elevenLabsTestState.streamCalls.push({ voiceId, text: options.text });
        return (async function* () {})();
      }),
    };
  },
}));

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const {
  decodeDataUriAudio,
  getTTSProvider,
  sanitizeForSpeech,
  synthesizeChatterboxTurbo,
  synthesizeDeepInfraTTS,
  synthesizeInworld,
  synthesizeKokoro,
} = await import("./tts.js");

/** A minimal fake `ChildProcess` covering only what `transcodeWavToMp3` uses. Events are emitted
 * via `queueMicrotask` — not synchronously inside `spawn()` — so they fire after the caller has
 * finished attaching its `.on` listeners, matching real child-process timing. */
function fakeFfmpegProcess({
  stdout = Buffer.alloc(0),
  exitCode = 0,
  spawnError,
}: {
  stdout?: Buffer;
  exitCode?: number;
  spawnError?: Error;
}): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: (b: Buffer) => void };
} {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: vi.fn() },
  });
  queueMicrotask(() => {
    if (spawnError) {
      child.emit("error", spawnError);
      return;
    }
    if (stdout.length > 0) child.stdout.emit("data", stdout);
    child.emit("close", exitCode);
  });
  return child;
}

/** Wraps bytes as a fetch `Response` whose `.body` streams them — mirrors the shape DeepInfra's
 * real streaming endpoint returns. */
function fetchResponseFromChunks(chunks: Uint8Array[], status = 200): Response {
  async function* body(): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) yield chunk;
  }
  const webStream = Readable.toWeb(Readable.from(body())) as unknown as ReadableStream<Uint8Array>;
  return new Response(webStream, { status });
}

/** Wraps raw text chunks (which may split NDJSON lines mid-line) as a fetch `Response` whose
 * `.body` streams them — mirrors Inworld's streaming endpoint, and exercises
 * `parseInworldStream`'s line-buffering rather than only the case where each chunk is one line. */
function ndjsonResponseFromRawChunks(rawChunks: string[], status = 200): Response {
  async function* body(): AsyncIterable<Uint8Array> {
    for (const chunk of rawChunks) yield new TextEncoder().encode(chunk);
  }
  const webStream = Readable.toWeb(Readable.from(body())) as unknown as ReadableStream<Uint8Array>;
  return new Response(webStream, { status });
}

describe("sanitizeForSpeech", () => {
  it("strips straight double quotes", () => {
    expect(sanitizeForSpeech('Small thing — "I saw a movie."')).toBe(
      "Small thing — I saw a movie.",
    );
  });

  it("strips curly/typographic double quotes", () => {
    expect(sanitizeForSpeech("Small thing — “I saw a movie.”")).toBe(
      "Small thing — I saw a movie.",
    );
  });

  it("preserves apostrophes in contractions", () => {
    expect(sanitizeForSpeech("you'd say I've been living here")).toBe(
      "you'd say I've been living here",
    );
  });

  it("preserves em dashes", () => {
    expect(sanitizeForSpeech("bare Make needs something — after it")).toBe(
      "bare Make needs something — after it",
    );
  });

  it("strips multiple quoted segments in one sentence", () => {
    const input = 'Ha, gotta say "Make it fast" or "speed things up" — bare "Make" needs it!';
    expect(sanitizeForSpeech(input)).toBe(
      "Ha, gotta say Make it fast or speed things up — bare Make needs it!",
    );
  });
});

describe("ElevenLabsTTSProvider.synthesize", () => {
  afterEach(() => {
    elevenLabsTestState.streamCalls.length = 0;
    delete process.env["TTS_PROVIDER"];
    delete process.env["ELEVENLABS_API_KEY"];
  });

  it("sends sanitized text to ElevenLabs, not the raw quoted text", async () => {
    process.env["TTS_PROVIDER"] = "elevenlabs";
    process.env["ELEVENLABS_API_KEY"] = "test-key";

    const { model } = await getTTSProvider().synthesize('Small thing — "I saw a movie."');

    expect(elevenLabsTestState.streamCalls.at(-1)?.text).toBe("Small thing — I saw a movie.");
    expect(model).toBe("eleven_flash_v2_5");
  });
});

describe("synthesizeKokoro", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env["DEEPINFRA_API_KEY"];
  });

  it("posts sanitized text to DeepInfra's stream endpoint for the given voice", async () => {
    process.env["DEEPINFRA_API_KEY"] = "test-deepinfra-key";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return fetchResponseFromChunks([new Uint8Array([9, 9])]);
    }) as unknown as typeof fetch;

    const { audio, model } = await synthesizeKokoro('Nice — "great job."', "af_bella");
    const chunks: Uint8Array[] = [];
    for await (const chunk of audio) chunks.push(chunk as Uint8Array);

    expect(capturedUrl).toBe(
      "https://api.deepinfra.com/v1/text-to-speech/af_bella/stream?output_format=mp3",
    );
    expect(capturedInit?.headers).toMatchObject({ "xi-api-key": "test-deepinfra-key" });
    // output_format must travel in the body, not just the query string — DeepInfra's stream
    // endpoint silently ignores the query param and falls back to its body-schema default
    // ("wav") otherwise, which is what broke Kokoro playback in the browser (it expects mp3).
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      text: "Nice — great job.",
      model_id: "hexgrad/Kokoro-82M",
      output_format: "mp3",
    });
    expect(model).toBe("hexgrad/Kokoro-82M");
    expect(chunks).toEqual([new Uint8Array([9, 9])]);
  });

  it("throws when DEEPINFRA_API_KEY is unset", async () => {
    await expect(synthesizeKokoro("hi", "af_heart")).rejects.toThrow("DEEPINFRA_API_KEY");
  });
});

describe("decodeDataUriAudio", () => {
  it("decodes the base64 payload of a data URI", () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const dataUri = `data:audio/wav;base64,${bytes.toString("base64")}`;

    expect(decodeDataUriAudio(dataUri)).toEqual(bytes);
  });

  it("throws a clear error when given a string that isn't a data URI", () => {
    expect(() => decodeDataUriAudio("not a data uri")).toThrow("data URI");
  });
});

describe("synthesizeChatterboxTurbo", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    spawnMock.mockReset();
    delete process.env["DEEPINFRA_API_KEY"];
  });

  it("posts sanitized text to DeepInfra's native endpoint and returns transcoded mp3 bytes", async () => {
    process.env["DEEPINFRA_API_KEY"] = "test-deepinfra-key";
    const wavBytes = Buffer.from([9, 9, 9]);
    const dataUri = `data:audio/wav;base64,${wavBytes.toString("base64")}`;
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return new Response(JSON.stringify({ audio: dataUri }), { status: 200 });
    }) as unknown as typeof fetch;
    const mp3Bytes = Buffer.from([1, 2, 3]);
    let capturedStdin: Buffer | undefined;
    spawnMock.mockImplementation((_cmd: string, _args: string[]) => {
      const child = fakeFfmpegProcess({ stdout: mp3Bytes, exitCode: 0 });
      capturedStdin = undefined;
      child.stdin.end = vi.fn((b: Buffer) => {
        capturedStdin = b;
      });
      return child;
    });

    const { audio, model } = await synthesizeChatterboxTurbo('Nice — "great job."');
    const chunks: Uint8Array[] = [];
    for await (const chunk of audio) chunks.push(chunk as Uint8Array);

    expect(capturedUrl).toBe("https://api.deepinfra.com/v1/inference/ResembleAI/chatterbox-turbo");
    expect(capturedInit?.headers).toMatchObject({ Authorization: "bearer test-deepinfra-key" });
    expect(JSON.parse(capturedInit?.body as string)).toEqual({ text: "Nice — great job." });
    expect(capturedStdin).toEqual(wavBytes);
    expect(chunks).toEqual([mp3Bytes]);
    expect(model).toBe("ResembleAI/chatterbox-turbo");
  });

  it("rejects with DeepInfra's error body when the request fails", async () => {
    process.env["DEEPINFRA_API_KEY"] = "test-key";
    global.fetch = vi.fn(
      async () => new Response("boom", { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(synthesizeChatterboxTurbo("hi")).rejects.toThrow("500");
  });

  it("rejects with ffmpeg's stderr when it exits non-zero", async () => {
    process.env["DEEPINFRA_API_KEY"] = "test-key";
    const dataUri = `data:audio/wav;base64,${Buffer.from([1]).toString("base64")}`;
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ audio: dataUri }), { status: 200 }),
    ) as unknown as typeof fetch;
    spawnMock.mockImplementation(() => {
      const child = fakeFfmpegProcess({ exitCode: 1 });
      queueMicrotask(() => child.stderr.emit("data", Buffer.from("invalid data")));
      return child;
    });

    await expect(synthesizeChatterboxTurbo("hi")).rejects.toThrow(/ffmpeg exited with code 1/);
  });

  it("rejects with an actionable message when ffmpeg isn't installed", async () => {
    process.env["DEEPINFRA_API_KEY"] = "test-key";
    const dataUri = `data:audio/wav;base64,${Buffer.from([1]).toString("base64")}`;
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ audio: dataUri }), { status: 200 }),
    ) as unknown as typeof fetch;
    spawnMock.mockImplementation(() =>
      fakeFfmpegProcess({
        spawnError: Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }),
      }),
    );

    await expect(synthesizeChatterboxTurbo("hi")).rejects.toThrow(/ffmpeg/);
  });
});

describe("synthesizeInworld", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env["INWORLD_API_KEY"];
    delete process.env["INWORLD_MODEL"];
  });

  it("posts sanitized text with the given voice, streaming decoded bytes as NDJSON lines arrive", async () => {
    process.env["INWORLD_API_KEY"] = "test-inworld-key";
    const chunk1 = Buffer.from([1, 2, 3]);
    const chunk2 = Buffer.from([4, 5]);
    const line1 = JSON.stringify({ result: { audioContent: chunk1.toString("base64") } });
    const line2 = JSON.stringify({ result: { audioContent: chunk2.toString("base64") } });
    // Split across raw chunk boundaries that don't align with line breaks, to exercise the
    // buffering logic rather than only the easy case where each read is exactly one line.
    const rawChunks = [
      line1.slice(0, 5),
      `${line1.slice(5)}\n${line2.slice(0, 3)}`,
      `${line2.slice(3)}\n`,
    ];
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return ndjsonResponseFromRawChunks(rawChunks);
    }) as unknown as typeof fetch;

    const { audio, model } = await synthesizeInworld('Nice — "great job."', "Sarah");
    const received: Uint8Array[] = [];
    for await (const chunk of audio) received.push(chunk as Uint8Array);

    expect(capturedUrl).toBe("https://api.inworld.ai/tts/v1/voice:stream");
    expect(capturedInit?.headers).toMatchObject({ Authorization: "Basic test-inworld-key" });
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      text: "Nice — great job.",
      voiceId: "Sarah",
      modelId: "inworld-tts-2-flash",
    });
    expect(received).toEqual([chunk1, chunk2]);
    expect(model).toBe("inworld-tts-2-flash");
  });

  it("yields the final line's audio even when the stream ends without a trailing newline", async () => {
    process.env["INWORLD_API_KEY"] = "test-inworld-key";
    const chunk1 = Buffer.from([1, 2, 3]);
    const chunk2 = Buffer.from([4, 5]);
    const line1 = JSON.stringify({ result: { audioContent: chunk1.toString("base64") } });
    const line2 = JSON.stringify({ result: { audioContent: chunk2.toString("base64") } });
    // Inworld's real stream doesn't always terminate its last NDJSON record with "\n" — the last
    // chunk here has no trailing newline, unlike the fully-terminated case above.
    global.fetch = vi.fn(async () =>
      ndjsonResponseFromRawChunks([`${line1}\n${line2}`]),
    ) as unknown as typeof fetch;

    const { audio } = await synthesizeInworld("hi", "Sarah");
    const received: Uint8Array[] = [];
    for await (const chunk of audio) received.push(chunk as Uint8Array);

    expect(received).toEqual([chunk1, chunk2]);
  });

  it("uses INWORLD_MODEL when set", async () => {
    process.env["INWORLD_API_KEY"] = "test-key";
    process.env["INWORLD_MODEL"] = "inworld-tts-2";
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedInit = init;
      return ndjsonResponseFromRawChunks([]);
    }) as unknown as typeof fetch;

    const { model } = await synthesizeInworld("hi", "Sarah");

    expect(JSON.parse(capturedInit?.body as string)).toMatchObject({ modelId: "inworld-tts-2" });
    expect(model).toBe("inworld-tts-2");
  });

  it("prefers an explicit modelOverride over INWORLD_MODEL", async () => {
    process.env["INWORLD_API_KEY"] = "test-key";
    process.env["INWORLD_MODEL"] = "inworld-tts-1.5-mini";
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedInit = init;
      return ndjsonResponseFromRawChunks([]);
    }) as unknown as typeof fetch;

    const { model } = await synthesizeInworld("hi", "Sarah", "inworld-tts-2");

    expect(JSON.parse(capturedInit?.body as string)).toMatchObject({ modelId: "inworld-tts-2" });
    expect(model).toBe("inworld-tts-2");
  });

  it("throws when a stream line contains an error field", async () => {
    process.env["INWORLD_API_KEY"] = "test-key";
    const line = JSON.stringify({ error: { message: "bad voice" } });
    global.fetch = vi.fn(async () =>
      ndjsonResponseFromRawChunks([`${line}\n`]),
    ) as unknown as typeof fetch;

    const { audio } = await synthesizeInworld("hi", "Sarah");

    await expect(
      (async () => {
        for await (const _chunk of audio) {
          /* drain */
        }
      })(),
    ).rejects.toThrow("bad voice");
  });

  it("throws when the request fails", async () => {
    process.env["INWORLD_API_KEY"] = "test-key";
    global.fetch = vi.fn(
      async () => new Response("boom", { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(synthesizeInworld("hi", "Sarah")).rejects.toThrow("500");
  });

  it("throws when INWORLD_API_KEY is unset", async () => {
    await expect(synthesizeInworld("hi", "Sarah")).rejects.toThrow("INWORLD_API_KEY");
  });
});

describe("synthesizeDeepInfraTTS", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env["DEEPINFRA_API_KEY"];
  });

  // Regression test: DeepInfra's stream endpoint was found to ignore the output_format query
  // param entirely and always return wav (its body-schema default) — requesting a format only
  // takes effect when it's also sent in the JSON body.
  it("requests the given output format in both the query string and the body", async () => {
    process.env["DEEPINFRA_API_KEY"] = "test-key";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return fetchResponseFromChunks([new Uint8Array([1])]);
    }) as unknown as typeof fetch;

    await synthesizeDeepInfraTTS("hi", "conversational_a", "sesame/csm-1b", "wav");

    expect(capturedUrl).toBe(
      "https://api.deepinfra.com/v1/text-to-speech/conversational_a/stream?output_format=wav",
    );
    expect(JSON.parse(capturedInit?.body as string)).toMatchObject({ output_format: "wav" });
  });
});

describe("getTTSProvider", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    elevenLabsTestState.streamCalls.length = 0;
    spawnMock.mockReset();
    delete process.env["TTS_PROVIDER"];
    delete process.env["DEEPINFRA_API_KEY"];
    delete process.env["ELEVENLABS_API_KEY"];
  });

  it("defaults to Kokoro when TTS_PROVIDER is unset", async () => {
    process.env["DEEPINFRA_API_KEY"] = "test-key";
    global.fetch = vi.fn(async () => fetchResponseFromChunks([])) as unknown as typeof fetch;

    await getTTSProvider().synthesize("hi");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(elevenLabsTestState.streamCalls).toEqual([]);
  });

  it("uses ElevenLabs when TTS_PROVIDER=elevenlabs", async () => {
    process.env["TTS_PROVIDER"] = "elevenlabs";
    process.env["ELEVENLABS_API_KEY"] = "test-key";

    await getTTSProvider().synthesize("hi");

    expect(elevenLabsTestState.streamCalls).toHaveLength(1);
  });

  it("uses Chatterbox-turbo when TTS_PROVIDER=chatterbox-turbo", async () => {
    process.env["TTS_PROVIDER"] = "chatterbox-turbo";
    process.env["DEEPINFRA_API_KEY"] = "test-key";
    const dataUri = `data:audio/wav;base64,${Buffer.from([1]).toString("base64")}`;
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ audio: dataUri }), { status: 200 }),
    ) as unknown as typeof fetch;
    spawnMock.mockImplementation(() => fakeFfmpegProcess({ stdout: Buffer.from([2]) }));

    const { model } = await getTTSProvider().synthesize("hi");

    expect(model).toBe("ResembleAI/chatterbox-turbo");
  });

  it("uses Inworld when TTS_PROVIDER=inworld", async () => {
    process.env["TTS_PROVIDER"] = "inworld";
    process.env["INWORLD_API_KEY"] = "test-key";
    global.fetch = vi.fn(
      async () =>
        new Response("", { status: 200, headers: { "content-type": "application/x-ndjson" } }),
    ) as unknown as typeof fetch;

    const { model } = await getTTSProvider().synthesize("hi");

    expect(model).toBe("inworld-tts-2-flash");
  });

  it("routes Inworld to the full model when highQuality is set", async () => {
    process.env["TTS_PROVIDER"] = "inworld";
    process.env["INWORLD_API_KEY"] = "test-key";
    global.fetch = vi.fn(
      async () =>
        new Response("", { status: 200, headers: { "content-type": "application/x-ndjson" } }),
    ) as unknown as typeof fetch;

    const { model } = await getTTSProvider({ highQuality: true }).synthesize("hi");

    expect(model).toBe("inworld-tts-2");
  });

  it("ignores highQuality for providers with no quality tier", async () => {
    process.env["DEEPINFRA_API_KEY"] = "test-key";
    global.fetch = vi.fn(async () => fetchResponseFromChunks([])) as unknown as typeof fetch;

    await getTTSProvider({ highQuality: true }).synthesize("hi");

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
