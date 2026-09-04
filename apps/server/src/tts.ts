import { spawn } from "node:child_process";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

/** ElevenLabs' "Rachel" premade voice — an existing preset voice, per the ticket's scope. */
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
/** A clear American-English female Kokoro voice — the closest preset analog to "Rachel." */
const DEFAULT_KOKORO_VOICE_ID = "af_heart";

export const ELEVENLABS_MODEL = "eleven_flash_v2_5";
export const KOKORO_MODEL = "hexgrad/Kokoro-82M";

export interface TTSProvider {
  /** Synthesizes `text` to speech, streamed as audio chunks as they're produced, alongside the
   * model that produced it (each provider reports its own — see `llm.ts`'s `LLMProvider` for the
   * same pattern). */
  synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }>;
}

/**
 * Strips double-quote characters before text reaches the TTS model. Quoted phrases (common when
 * Kalli repeats back a corrected phrase) came out of `eleven_flash_v2_5` sounding like
 * mispronounced punctuation rather than prosody; applied to every provider by default, pending a
 * listening check on whether Kokoro needs the same treatment. Apostrophes are left untouched since
 * they're load-bearing for contractions ("I'll", "you'd").
 */
export function sanitizeForSpeech(text: string): string {
  return text.replace(/["“”]/g, "");
}

function getApiKey(): string {
  const apiKey = process.env["ELEVENLABS_API_KEY"];
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is required (see apps/server/.env.example)");
  }
  return apiKey;
}

function getVoiceId(): string {
  return process.env["ELEVENLABS_VOICE_ID"] || DEFAULT_VOICE_ID;
}

let client: ElevenLabsClient | undefined;

function getClient(): ElevenLabsClient {
  client ??= new ElevenLabsClient({ apiKey: getApiKey() });
  return client;
}

export class ElevenLabsTTSProvider implements TTSProvider {
  async synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
    const audio = await getClient().textToSpeech.stream(getVoiceId(), {
      text: sanitizeForSpeech(text),
      modelId: ELEVENLABS_MODEL,
      outputFormat: "mp3_44100_128",
    });
    return { audio, model: ELEVENLABS_MODEL };
  }
}

export function getDeepInfraApiKey(): string {
  const apiKey = process.env["DEEPINFRA_API_KEY"];
  if (!apiKey) {
    throw new Error("DEEPINFRA_API_KEY is required (see apps/server/.env.example)");
  }
  return apiKey;
}

/** Calls DeepInfra's ElevenLabs-compatible TTS endpoint for a specific model and voice — factored
 * out so the voice-comparison script (`src/scripts/compareTts.ts`) can request multiple candidate
 * models/voices (Kokoro, CSM-1B, ...) without duplicating the request shape. DeepInfra hosts
 * several open TTS models behind this same `/v1/text-to-speech/{voice_id}/stream` facade,
 * distinguished only by `model_id`. */
export async function synthesizeDeepInfraTTS(
  text: string,
  voiceId: string,
  modelId: string,
  outputFormat: "mp3" | "wav" = "mp3",
): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
  const response = await fetch(
    `https://api.deepinfra.com/v1/text-to-speech/${voiceId}/stream?output_format=${outputFormat}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": getDeepInfraApiKey(),
        "content-type": "application/json",
      },
      // output_format must be repeated here — the query param above is silently ignored by
      // DeepInfra's stream endpoint, which otherwise falls back to its body-schema default
      // ("wav") regardless of what's requested in the URL.
      body: JSON.stringify({
        text: sanitizeForSpeech(text),
        model_id: modelId,
        output_format: outputFormat,
      }),
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`DeepInfra TTS request failed: ${response.status} ${await response.text()}`);
  }
  return { audio: response.body, model: modelId };
}

export function synthesizeKokoro(
  text: string,
  voiceId: string,
): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
  // "mp3" passed explicitly (matching the default) rather than omitted — this call must always
  // request mp3 to match the browser's hardcoded `audio/mpeg` MediaSource buffer, so it's spelled
  // out here instead of relying on a default that a future signature change could alter unnoticed.
  return synthesizeDeepInfraTTS(text, voiceId, KOKORO_MODEL, "mp3");
}

class KokoroTTSProvider implements TTSProvider {
  synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
    return synthesizeKokoro(text, process.env["DEEPINFRA_VOICE_ID"] || DEFAULT_KOKORO_VOICE_ID);
  }
}

export const CHATTERBOX_TURBO_MODEL = "ResembleAI/chatterbox-turbo";

/** Decodes a `data:<mime>;base64,<data>` URI into its raw bytes — the shape DeepInfra's native
 * (non-streaming) inference endpoint returns audio in. */
export function decodeDataUriAudio(dataUri: string): Buffer {
  const base64 = dataUri.split(",")[1];
  if (!dataUri.startsWith("data:") || !base64) {
    throw new Error(
      `Expected a data URI (data:<mime>;base64,<data>), got: ${dataUri.slice(0, 40)}`,
    );
  }
  return Buffer.from(base64, "base64");
}

/**
 * Transcodes WAV bytes to MP3 by shelling out to `ffmpeg` (must be on `PATH` — installed via apt in
 * the production Dockerfile; `brew install ffmpeg` for local dev). Chatterbox-turbo's DeepInfra
 * endpoint only ever emits WAV (confirmed live — an `output_format` field isn't even validated, so
 * it's not sent), but the browser's `MediaSource` buffer is hardcoded to `audio/mpeg`
 * (`apps/web/src/Session.tsx`), so this bridges the two rather than changing the client.
 */
function transcodeWavToMp3(wav: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-f",
      "mp3",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "128k",
      "pipe:1",
    ]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    ffmpeg.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    ffmpeg.on("error", (error) => {
      reject(
        new Error(
          "Failed to spawn ffmpeg (required for Chatterbox-turbo's WAV→MP3 transcode — " +
            `install it: apt package "ffmpeg" in production, "brew install ffmpeg" locally): ${error.message}`,
        ),
      );
    });
    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(stderr).toString("utf8")}`),
        );
        return;
      }
      resolve(Buffer.concat(stdout));
    });
    ffmpeg.stdin.end(wav);
  });
}

async function* singleChunk(buffer: Buffer): AsyncIterable<Uint8Array> {
  yield buffer;
}

/**
 * Calls DeepInfra's native (non-streaming) inference endpoint for Chatterbox-turbo directly —
 * its ElevenLabs-compatible streaming endpoint (used by `synthesizeKokoro`/`synthesizeDeepInfraTTS`
 * above) hangs and never delivers a byte for this model (confirmed by direct testing, not a cold
 * start). The native endpoint returns the whole utterance as one WAV blob rather than a stream, so
 * there's no within-sentence progressive playback for this provider — only the existing
 * sentence-level pipelining in `session.ts` still applies.
 */
export async function synthesizeChatterboxTurbo(
  text: string,
): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
  const response = await fetch(`https://api.deepinfra.com/v1/inference/${CHATTERBOX_TURBO_MODEL}`, {
    method: "POST",
    headers: {
      Authorization: `bearer ${getDeepInfraApiKey()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: sanitizeForSpeech(text) }),
  });
  if (!response.ok) {
    throw new Error(
      `DeepInfra ${CHATTERBOX_TURBO_MODEL} inference failed: ${response.status} ${await response.text()}`,
    );
  }
  const result = (await response.json()) as { audio: string };
  const mp3 = await transcodeWavToMp3(decodeDataUriAudio(result.audio));
  return { audio: singleChunk(mp3), model: CHATTERBOX_TURBO_MODEL };
}

class ChatterboxTurboTTSProvider implements TTSProvider {
  synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
    return synthesizeChatterboxTurbo(text);
  }
}

/** A clear American-English female Inworld voice — the closest preset analog to "Rachel." Used
 * across Inworld's own quickstart examples, so a safe reasonable default. */
const DEFAULT_INWORLD_VOICE_ID = "Sarah";
/** Flash is Inworld's cheapest/fastest tier (~$5-15/1M chars, ~20ms TTFB per their docs) — the one
 * that was actually evaluated for cost, and the default for ordinary sentences. */
const DEFAULT_INWORLD_MODEL = "inworld-tts-2-flash";
/**
 * The full model, used only for the one sentence per turn (if any) carrying an emphasized word
 * (see `emphasisMarkers.ts`) — confirmed via listening comparison that capitalization-based
 * emphasis (`getTTSProvider`'s `highQuality` option) reads clearly on `inworld-tts-2` but not on
 * `inworld-tts-2-flash`. Materially higher latency/cost than flash, which is why it's scoped to
 * just the emphasized sentence rather than used as the default.
 */
const EMPHASIS_INWORLD_MODEL = "inworld-tts-2";

function getInworldApiKey(): string {
  const apiKey = process.env["INWORLD_API_KEY"];
  if (!apiKey) {
    throw new Error("INWORLD_API_KEY is required (see apps/server/.env.example)");
  }
  return apiKey;
}

/**
 * Parses Inworld's streaming response — newline-delimited JSON, one `{"result": {"audioContent":
 * "<base64>"}}` object per line — into raw audio bytes, decoding and yielding each chunk as it
 * arrives rather than waiting for the full response. This is what actually gets Chatterbox-turbo's
 * problem (waiting seconds for a whole-utterance blob) fixed: genuine within-sentence streaming,
 * not just a fast model.
 */
async function* parseInworldStream(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line) continue;
      const parsed = JSON.parse(line) as {
        result?: { audioContent?: string };
        error?: unknown;
      };
      if (parsed.error) {
        throw new Error(`Inworld TTS stream returned an error: ${JSON.stringify(parsed.error)}`);
      }
      if (parsed.result?.audioContent) yield Buffer.from(parsed.result.audioContent, "base64");
    }
  }
}

/**
 * Verified against the live API (2026-09-03 listening comparison — see
 * `scripts/inworldEmphasis.ts`/`inworldModelSwitch.ts`): NDJSON parsing and request shape both
 * confirmed correct.
 *
 * `audioConfig.audioEncoding` is left at its documented default (`MP3`) rather than specified
 * explicitly — unlike Kokoro, where the default had to be overridden because DeepInfra's default is
 * `wav`. No transcoding step needed here.
 */
export async function synthesizeInworld(
  text: string,
  voiceId: string,
  modelOverride?: string,
): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
  const model = modelOverride || process.env["INWORLD_MODEL"] || DEFAULT_INWORLD_MODEL;
  const response = await fetch("https://api.inworld.ai/tts/v1/voice:stream", {
    method: "POST",
    headers: {
      Authorization: `Basic ${getInworldApiKey()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: sanitizeForSpeech(text), voiceId, modelId: model }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Inworld TTS request failed: ${response.status} ${await response.text()}`);
  }
  return { audio: parseInworldStream(response.body), model };
}

class InworldTTSProvider implements TTSProvider {
  constructor(private readonly modelOverride?: string) {}

  synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
    return synthesizeInworld(
      text,
      process.env["INWORLD_VOICE_ID"] || DEFAULT_INWORLD_VOICE_ID,
      this.modelOverride,
    );
  }
}

export interface GetTTSProviderOptions {
  /**
   * Routes this call to the higher-quality (and higher-latency/cost) tier when the provider
   * supports one — currently only Inworld, whose emphasis markup (`emphasisMarkers.ts`) reads
   * clearly on `inworld-tts-2` but not on the default `inworld-tts-2-flash`. Providers with no
   * such tier ignore this option.
   */
  highQuality?: boolean;
}

/**
 * Picks the provider fresh on every call based on `TTS_PROVIDER` (no memoized singleton — each
 * provider class is stateless, the one expensive lazy object is `client` above, which is already
 * cached independently) so the env var can be flipped per-call, which is also what makes it
 * straightforward to exercise every branch in tests.
 */
export function getTTSProvider(options: GetTTSProviderOptions = {}): TTSProvider {
  const providerName = process.env["TTS_PROVIDER"];
  if (providerName === "elevenlabs") return new ElevenLabsTTSProvider();
  if (providerName === "chatterbox-turbo") return new ChatterboxTurboTTSProvider();
  if (providerName === "inworld") {
    return new InworldTTSProvider(options.highQuality ? EMPHASIS_INWORLD_MODEL : undefined);
  }
  return new KokoroTTSProvider();
}
