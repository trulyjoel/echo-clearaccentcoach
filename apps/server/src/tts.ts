import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

/** ElevenLabs' "Rachel" premade voice — an existing preset voice, per the ticket's scope. */
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

export interface TTSProvider {
  /** Synthesizes `text` to speech, streamed as audio chunks as they're produced. */
  synthesize(text: string): Promise<AsyncIterable<Uint8Array>>;
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
  async synthesize(text: string): Promise<AsyncIterable<Uint8Array>> {
    return getClient().textToSpeech.stream(getVoiceId(), {
      text,
      modelId: "eleven_flash_v2_5",
      outputFormat: "mp3_44100_128",
    });
  }
}

let provider: TTSProvider | undefined;

export function getTTSProvider(): TTSProvider {
  provider ??= new ElevenLabsTTSProvider();
  return provider;
}
