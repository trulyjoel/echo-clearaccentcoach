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
  return process.env["ELEVENLABS_VOICE_ID"] ?? DEFAULT_VOICE_ID;
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

function getDeepInfraApiKey(): string {
  const apiKey = process.env["DEEPINFRA_API_KEY"];
  if (!apiKey) {
    throw new Error("DEEPINFRA_API_KEY is required (see apps/server/.env.example)");
  }
  return apiKey;
}

/** Reads a fetch `Response` body stream as an `AsyncIterable<Uint8Array>`. Reading directly from
 * the reader (rather than via `Readable.fromWeb`) keeps chunks as plain `Uint8Array` instead of
 * Node `Buffer` instances, matching the `TTSProvider` interface exactly. */
async function* streamBody(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

/** Calls DeepInfra's Kokoro endpoint for a specific voice — factored out so the voice-comparison
 * script (`src/scripts/compareTts.ts`) can request multiple candidate voices without duplicating
 * the request shape. */
export async function synthesizeKokoro(
  text: string,
  voiceId: string,
): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
  const response = await fetch(
    `https://api.deepinfra.com/v1/text-to-speech/${voiceId}/stream?output_format=mp3`,
    {
      method: "POST",
      headers: {
        "xi-api-key": getDeepInfraApiKey(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: sanitizeForSpeech(text), model_id: KOKORO_MODEL }),
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`DeepInfra TTS request failed: ${response.status} ${await response.text()}`);
  }
  return { audio: streamBody(response.body), model: KOKORO_MODEL };
}

class KokoroTTSProvider implements TTSProvider {
  synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
    return synthesizeKokoro(text, process.env["DEEPINFRA_VOICE_ID"] ?? DEFAULT_KOKORO_VOICE_ID);
  }
}

/**
 * Picks the provider fresh on every call based on `TTS_PROVIDER` (no memoized singleton — each
 * provider class is stateless, the one expensive lazy object is `client` above, which is already
 * cached independently) so the env var can be flipped per-call, which is also what makes it
 * straightforward to exercise both branches in tests.
 */
export function getTTSProvider(): TTSProvider {
  return process.env["TTS_PROVIDER"] === "elevenlabs"
    ? new ElevenLabsTTSProvider()
    : new KokoroTTSProvider();
}
