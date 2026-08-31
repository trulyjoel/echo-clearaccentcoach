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

const { getTTSProvider, sanitizeForSpeech, synthesizeDeepInfraTTS, synthesizeKokoro } =
  await import("./tts.js");

/** Wraps bytes as a fetch `Response` whose `.body` streams them — mirrors the shape DeepInfra's
 * real streaming endpoint returns. */
function fetchResponseFromChunks(chunks: Uint8Array[], status = 200): Response {
  async function* body(): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) yield chunk;
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
});
