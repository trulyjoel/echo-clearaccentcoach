import { DeepgramClient } from "@deepgram/sdk";

export const DEEPGRAM_MODEL = "flux-general-en";

export interface DeepgramTurnInfoMessage {
  type: "TurnInfo";
  event: "Update" | "StartOfTurn" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn" | string;
  turn_index: number;
  transcript: string;
}

/**
 * The message types Flux's live API can send; only TurnInfo carries a transcript or turn
 * event. `FatalError` is a protocol-level error distinct from the connection's own `error`
 * event and is routed the same way (session-ending) rather than silently dropped like the
 * handshake/config acks.
 */
export type DeepgramMessage =
  | DeepgramTurnInfoMessage
  | { type: "Connected" }
  | { type: "ConfigureSuccess" }
  | { type: "ConfigureFailure" }
  | { type: "FatalError" };

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
  const connection = (await getClient().listen.v2.connect({
    model: DEEPGRAM_MODEL,
    // `encoding`/`sample_rate` are deliberately omitted: both are for non-containerized/raw
    // audio. The browser sends containerized WebM/Opus, which Flux auto-detects the same way
    // Nova-3 did.
    // Deepgram's stated default — the confidence Flux itself requires before it decides the
    // turn is over. Unlike Nova-3's endpointing, this is a model judgment, not a silence
    // timer, so it isn't a straight port of the old 300ms value.
    eot_threshold: "0.7",
    // Forces a turn to end after this much time regardless of confidence, so a turn can't
    // get stuck forever if the model never reaches eot_threshold — same purpose as Nova-3's
    // utterance_end_ms fallback, at Deepgram's stated default.
    eot_timeout_ms: "5000",
    // `eager_eot_threshold` is deliberately left unset: per the SDK's own docs, setting it is
    // what opts a session into EagerEndOfTurn/TurnResumed events (start-reply-early +
    // cancel-on-resumed-speech). That's a further latency optimization for later, not part of
    // this migration — leaving it unset means the connection never emits those events.
    // The WS connect call doesn't inherit the client's apiKey as an auth header — Deepgram's
    // scheme is "Authorization: Token <key>", unlike the REST client's own auth provider.
    Authorization: `Token ${getApiKey()}`,
  })) as unknown as DeepgramConnection;

  connection.connect();
  await connection.waitForOpen();

  return connection;
}
