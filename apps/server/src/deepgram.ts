import { DeepgramClient } from "@deepgram/sdk";

export interface DeepgramResultsMessage {
  type: "Results";
  is_final?: boolean;
  speech_final?: boolean;
  channel: { alternatives: Array<{ transcript: string }> };
}

/** The message types Deepgram's live API can send; only Results carries a transcript. */
export type DeepgramMessage =
  | DeepgramResultsMessage
  | { type: "Metadata" }
  | { type: "UtteranceEnd" };

export interface DeepgramConnection {
  connect(): void;
  waitForOpen(): Promise<void>;
  sendMedia(chunk: Buffer): void;
  close(): void;
  on(event: "message", listener: (data: DeepgramMessage) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
}

function getApiKey(): string {
  const apiKey = process.env["DEEPGRAM_API_KEY"];
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY is required (see apps/server/.env.example)");
  }
  return apiKey;
}

let client: DeepgramClient | undefined;

function getClient(): DeepgramClient {
  client ??= new DeepgramClient({ apiKey: getApiKey() });
  return client;
}

/** Opens a live transcription connection to Deepgram, open and ready to receive audio. */
export async function openDeepgramConnection(): Promise<DeepgramConnection> {
  const connection = (await getClient().listen.v1.connect({
    model: "nova-3",
    language: "en",
    punctuate: "true",
    interim_results: "true",
    // Deepgram's default (10ms of silence) is tuned for short chatbot-style utterances and
    // finalizes on any brief mid-sentence breath, prematurely ending a turn the user hasn't
    // actually finished — 300ms is Deepgram's own recommended value for conversational speech
    // where speakers pause mid-thought.
    endpointing: "300",
    // Endpointing's speech_final can fail to fire at all (VAD/background-noise interaction is a
    // known Deepgram limitation, not just an edge case) and leave a turn stuck forever. Deepgram's
    // own docs recommend running UtteranceEnd alongside it as an independent fallback signal —
    // 1000ms is its documented minimum.
    utterance_end_ms: "1000",
    // The WS connect call doesn't inherit the client's apiKey as an auth header — Deepgram's
    // scheme is "Authorization: Token <key>", unlike the REST client's own auth provider.
    Authorization: `Token ${getApiKey()}`,
  })) as unknown as DeepgramConnection;

  connection.connect();
  await connection.waitForOpen();

  return connection;
}
