import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

/** ElevenLabs' "Rachel" premade voice — an existing preset voice, per the ticket's scope. */
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

export const ELEVENLABS_MODEL = "eleven_flash_v2_5";

export interface TTSProvider {
  /** Synthesizes `text` to speech, streamed as audio chunks as they're produced, alongside the
   * model that produced it (each provider reports its own — see `llm.ts`'s `LLMProvider` for the
   * same pattern). */
  synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }>;
}

/**
 * Strips double-quote characters before text reaches the TTS model. `eleven_flash_v2_5` skips
 * text normalization for latency and reads unusual punctuation density literally rather than as
 * prosody — quoted phrases (common when Kalli repeats back a corrected phrase) came out sounding
 * like mispronounced punctuation. Apostrophes are left untouched since they're load-bearing for
 * contractions ("I'll", "you'd").
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

class ElevenLabsTTSProvider implements TTSProvider {
  async synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
    const audio = await getClient().textToSpeech.stream(getVoiceId(), {
      text: sanitizeForSpeech(text),
      modelId: ELEVENLABS_MODEL,
      outputFormat: "mp3_44100_128",
    });
    return { audio, model: ELEVENLABS_MODEL };
  }
}

let provider: TTSProvider | undefined;

export function getTTSProvider(): TTSProvider {
  provider ??= new ElevenLabsTTSProvider();
  return provider;
}
