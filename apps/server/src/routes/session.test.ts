import type { DetectedError, L1, ServerToClientMessage } from "@kalli/types";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { audioClips, profiles, sessions, turnErrors, turns, usageRecords } from "../db/schema.js";
import type { DeepgramConnection, DeepgramMessage } from "../deepgram.js";
import type { ConversationMessage } from "../llm.js";

type InjectedWebSocket = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

type FakeAuthRequest = FastifyRequest & {
  auth?: { isAuthenticated: boolean; userId: string | null };
};

vi.mock("@clerk/fastify", () => ({
  // The real clerkPlugin computes auth once, in an `onRequest` hook, from whatever headers are
  // present *at that point* in the request lifecycle, and getAuth just reads the cached result —
  // it does not re-read headers on every call. Mocked this way (rather than a getAuth that
  // freshly reads request.headers.authorization on every call) so tests can catch bugs where a
  // header is set too late, e.g. by a preValidation hook running after onRequest already fired.
  clerkPlugin: Object.assign(
    async (instance: FastifyInstance) => {
      instance.decorateRequest("auth", null);
      instance.addHook("onRequest", async (request: FakeAuthRequest) => {
        request.auth =
          request.headers.authorization === "Bearer test-user-session-456"
            ? { isAuthenticated: true, userId: "test-user-session-456" }
            : { isAuthenticated: false, userId: null };
      });
    },
    // Marks this as a "fastify-plugin" so its onRequest hook attaches to the same encapsulation
    // as the caller (matching the real @clerk/fastify, which uses the `fastify-plugin` package)
    // instead of being scoped to a hidden child context invisible to sibling routes.
    { [Symbol.for("skip-override")]: true },
  ),
  getAuth: (request: FakeAuthRequest) => request.auth,
}));

const deepgramTestState = vi.hoisted(() => {
  class FakeDeepgramConnection implements DeepgramConnection {
    sentMedia: Buffer[] = [];
    closed = false;
    private messageListener: ((data: DeepgramMessage) => void) | undefined;
    private errorListener: ((error: Error) => void) | undefined;
    private closeListener: (() => void) | undefined;

    connect(): void {}

    async waitForOpen(): Promise<void> {}

    sendMedia(chunk: Buffer): void {
      this.sentMedia.push(chunk);
    }

    close(): void {
      this.closed = true;
    }

    on(event: "message", listener: (data: DeepgramMessage) => void): void;
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "close", listener: () => void): void;
    on(event: "message" | "error" | "close", listener: (...args: never[]) => void): void {
      if (event === "message") this.messageListener = listener as (data: DeepgramMessage) => void;
      if (event === "error") this.errorListener = listener as (error: Error) => void;
      if (event === "close") this.closeListener = listener as () => void;
    }

    emitMessage(data: DeepgramMessage): void {
      this.messageListener?.(data);
    }

    emitError(error: Error): void {
      this.errorListener?.(error);
    }

    emitClose(): void {
      this.closeListener?.();
    }
  }

  let latest: FakeDeepgramConnection | undefined;
  let shouldFail = false;

  return {
    getLatest: (): FakeDeepgramConnection | undefined => latest,
    setShouldFail: (value: boolean): void => {
      shouldFail = value;
    },
    openDeepgramConnection: vi.fn(async (): Promise<DeepgramConnection> => {
      if (shouldFail) throw new Error("Deepgram unavailable");
      const connection = new FakeDeepgramConnection();
      latest = connection;
      return connection;
    }),
  };
});

vi.mock("../deepgram.js", () => ({
  openDeepgramConnection: deepgramTestState.openDeepgramConnection,
}));

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

const llmTestState = vi.hoisted(() => {
  const DEFAULT_ANALYZE_USAGE: TokenUsage = { inputTokens: 8, outputTokens: 2 };
  const DEFAULT_REPLY_USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5 };
  let replyImpl: (
    history: ConversationMessage[],
    errors: DetectedError[],
  ) => Promise<string> = async () => "Nice job!";
  let analyzeImpl: (transcript: string, l1: L1) => Promise<DetectedError[]> = async () => [];
  let analyzeUsage: TokenUsage = DEFAULT_ANALYZE_USAGE;
  let replyUsage: TokenUsage = DEFAULT_REPLY_USAGE;
  const calls: ConversationMessage[][] = [];
  const replyErrorArgs: DetectedError[][] = [];
  const analyzeCalls: string[] = [];
  const analyzeL1Calls: L1[] = [];

  return {
    reset: (): void => {
      replyImpl = async () => "Nice job!";
      analyzeImpl = async () => [];
      analyzeUsage = DEFAULT_ANALYZE_USAGE;
      replyUsage = DEFAULT_REPLY_USAGE;
      calls.length = 0;
      replyErrorArgs.length = 0;
      analyzeCalls.length = 0;
      analyzeL1Calls.length = 0;
    },
    setReplyImpl: (
      fn: (history: ConversationMessage[], errors: DetectedError[]) => Promise<string>,
    ): void => {
      replyImpl = fn;
    },
    setAnalyzeImpl: (fn: (transcript: string, l1: L1) => Promise<DetectedError[]>): void => {
      analyzeImpl = fn;
    },
    setAnalyzeUsage: (usage: TokenUsage): void => {
      analyzeUsage = usage;
    },
    setReplyUsage: (usage: TokenUsage): void => {
      replyUsage = usage;
    },
    getCalls: (): ConversationMessage[][] => calls,
    getReplyErrorArgs: (): DetectedError[][] => replyErrorArgs,
    getAnalyzeCalls: (): string[] => analyzeCalls,
    getAnalyzeL1Calls: (): L1[] => analyzeL1Calls,
    getLLMProvider: vi.fn(() => ({
      analyzeErrors: async (transcript: string, l1: L1) => {
        analyzeCalls.push(transcript);
        analyzeL1Calls.push(l1);
        const errors = await analyzeImpl(transcript, l1);
        return { errors, usage: analyzeUsage };
      },
      // Adapts the still Promise<string>-shaped `replyImpl` fixtures used throughout this file
      // into the real (streaming) LLMProvider contract: the whole reply text arrives as one
      // delta once `replyImpl`'s promise settles, which every fixture's reply text (a single
      // short sentence, no embedded sentence breaks) still resolves to exactly one TTS call —
      // the same shape the pre-streaming tests asserted against.
      generateReply: (history: ConversationMessage[], errors: DetectedError[]) => {
        calls.push(history);
        replyErrorArgs.push(errors);
        const textPromise = replyImpl(history, errors);
        async function* textStream(): AsyncGenerator<string> {
          yield await textPromise;
        }
        const usage = textPromise.then(() => replyUsage);
        // `usage` is only read by session.ts on the success path — a rejected `textPromise`
        // (simulating an LLM failure) would otherwise surface as an unhandled rejection here,
        // since nothing else attaches a handler to this specific derived promise.
        usage.catch(() => {});
        return { textStream: textStream(), usage };
      },
    })),
  };
});

vi.mock("../llm.js", () => ({ getLLMProvider: llmTestState.getLLMProvider }));

const ttsTestState = vi.hoisted(() => {
  async function* defaultChunks(): AsyncIterable<Uint8Array> {
    yield new Uint8Array([1, 2, 3]);
    yield new Uint8Array([4, 5]);
  }

  let synthesizeImpl: (text: string) => Promise<AsyncIterable<Uint8Array>> = async () =>
    defaultChunks();
  const calls: string[] = [];

  return {
    reset: (): void => {
      synthesizeImpl = async () => defaultChunks();
      calls.length = 0;
    },
    setSynthesizeImpl: (fn: (text: string) => Promise<AsyncIterable<Uint8Array>>): void => {
      synthesizeImpl = fn;
    },
    getCalls: (): string[] => calls,
    getTTSProvider: vi.fn(() => ({
      synthesize: async (text: string) => {
        calls.push(text);
        return synthesizeImpl(text);
      },
    })),
  };
});

vi.mock("../tts.js", () => ({ getTTSProvider: ttsTestState.getTTSProvider }));

const storageTestState = vi.hoisted(() => {
  const uploads: Array<{ key: string; data: Buffer; contentType: string }> = [];

  return {
    reset: (): void => {
      uploads.length = 0;
    },
    getUploads: (): Array<{ key: string; data: Buffer; contentType: string }> => uploads,
    getStorageProvider: vi.fn(() => ({
      upload: async (key: string, data: Buffer, contentType: string) => {
        uploads.push({ key, data, contentType });
      },
      delete: async () => {},
    })),
  };
});

vi.mock("../storage.js", () => ({ getStorageProvider: storageTestState.getStorageProvider }));

// vitest hoists imports above vi.mock calls, so app.js must be imported after the mocks above are set up.
const { buildApp } = await import("../app.js");

async function giveConsent(l1: L1 = "spanish"): Promise<void> {
  await db
    .insert(profiles)
    .values({ clerkUserId: "test-user-session-456", l1, consentGivenAt: new Date() });
}

/**
 * Buffers every message from connection open so bursts of back-to-back sends (e.g. an error
 * immediately followed by session_ended) can't race a listener that's only attached afterward.
 */
function messageQueue(ws: InjectedWebSocket): { next: () => Promise<ServerToClientMessage> } {
  const received: ServerToClientMessage[] = [];
  const waiters: Array<(message: ServerToClientMessage) => void> = [];

  ws.on("message", (data: Buffer) => {
    const message = JSON.parse(data.toString()) as ServerToClientMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else received.push(message);
  });

  return {
    next: (): Promise<ServerToClientMessage> => {
      const message = received.shift();
      if (message) return Promise.resolve(message);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/**
 * Like `messageQueue`, but also buffers raw binary frames (the streamed reply audio),
 * tagged so ordering assertions can interleave JSON and binary expectations.
 */
type QueuedFrame =
  | { kind: "json"; message: ServerToClientMessage }
  | { kind: "binary"; data: Buffer };

function mixedQueue(ws: InjectedWebSocket): { next: () => Promise<QueuedFrame> } {
  const received: QueuedFrame[] = [];
  const waiters: Array<(frame: QueuedFrame) => void> = [];

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    const frame: QueuedFrame = isBinary
      ? { kind: "binary", data }
      : { kind: "json", message: JSON.parse(data.toString()) as ServerToClientMessage };
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else received.push(frame);
  });

  return {
    next: (): Promise<QueuedFrame> => {
      const frame = received.shift();
      if (frame) return Promise.resolve(frame);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

afterEach(async () => {
  deepgramTestState.setShouldFail(false);
  llmTestState.reset();
  ttsTestState.reset();
  storageTestState.reset();
  await db.delete(turnErrors);
  await db.delete(turns);
  await db.delete(usageRecords);
  await db.delete(audioClips);
  await db.delete(sessions);
  await db.delete(profiles);
});

describe("GET /api/session", () => {
  it("rejects the upgrade when not authenticated", async () => {
    const app = buildApp();
    await app.ready();

    await expect(app.injectWS("/api/session")).rejects.toThrow(/401/);

    await app.close();
  });

  it("sends an error message and closes when the user hasn't completed onboarding consent", async () => {
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = messageQueue(ws);

    expect(await queue.next()).toEqual({
      type: "error",
      message: "Recording consent required",
    });
    await new Promise<void>((resolve) => ws.on("close", resolve));

    expect(await db.select().from(sessions)).toHaveLength(0);

    await app.close();
  });

  it("accepts a token passed as a query param, since browsers can't set WS headers", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session?token=test-user-session-456");
    const message = await messageQueue(ws).next();

    expect(message.type).toBe("session_started");

    ws.terminate();
    await app.close();
  });

  it("creates a session record and sends session_started for a consented user", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const message = await messageQueue(ws).next();

    expect(message).toEqual({ type: "session_started", sessionId: expect.any(String) });

    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.clerkUserId, "test-user-session-456"));
    expect(row?.endedAt).toBeNull();

    ws.terminate();
    await app.close();
  });

  it("forwards binary audio frames to the Deepgram connection", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    await messageQueue(ws).next(); // session_started

    ws.send(Buffer.from([1, 2, 3]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const connection = deepgramTestState.getLatest();
    expect(connection?.sentMedia).toHaveLength(1);
    expect(connection?.sentMedia[0]).toEqual(Buffer.from([1, 2, 3]));

    ws.terminate();
    await app.close();
  });

  it("relays a Deepgram transcript to the client", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = messageQueue(ws);
    await queue.next(); // session_started

    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: false,
      speech_final: false,
      channel: { alternatives: [{ transcript: "hello there" }] },
    });

    expect(await queue.next()).toEqual({ type: "transcript", text: "hello there", isFinal: false });

    ws.terminate();
    await app.close();
  });

  it("signals end_of_turn when Deepgram marks a result speech_final", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = messageQueue(ws);
    await queue.next(); // session_started

    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: "goodbye" }] },
    });
    expect(await queue.next()).toEqual({ type: "transcript", text: "goodbye", isFinal: true });
    expect(await queue.next()).toEqual({ type: "end_of_turn" });

    ws.terminate();
    await app.close();
  });

  it("ends the session with reason user_ended when the client sends end_session", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = messageQueue(ws);
    const { sessionId } = (await queue.next()) as { type: "session_started"; sessionId: string };

    ws.send(JSON.stringify({ type: "end_session" }));
    expect(await queue.next()).toEqual({ type: "session_ended", reason: "user_ended" });

    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.endedAt).not.toBeNull();
    expect(row?.endReason).toBe("user_ended");
    expect(deepgramTestState.getLatest()?.closed).toBe(true);

    await app.close();
  });

  it("ends the session with reason disconnected when the client drops the connection", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const { sessionId } = (await messageQueue(ws).next()) as {
      type: "session_started";
      sessionId: string;
    };

    ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.endedAt).not.toBeNull();
    expect(row?.endReason).toBe("disconnected");

    await app.close();
  });

  it("ends the session with reason error when the Deepgram connection errors mid-session", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = messageQueue(ws);
    const { sessionId } = (await queue.next()) as { type: "session_started"; sessionId: string };

    deepgramTestState.getLatest()?.emitError(new Error("stream reset"));

    expect(await queue.next()).toEqual({ type: "error", message: "Transcription error" });
    expect(await queue.next()).toEqual({ type: "session_ended", reason: "error" });

    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.endedAt).not.toBeNull();
    expect(row?.endReason).toBe("error");

    await app.close();
  });

  it("ends the session with reason error when the Deepgram connection closes unexpectedly", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = messageQueue(ws);
    const { sessionId } = (await queue.next()) as { type: "session_started"; sessionId: string };

    deepgramTestState.getLatest()?.emitClose();

    expect(await queue.next()).toEqual({ type: "session_ended", reason: "error" });

    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.endReason).toBe("error");

    await app.close();
  });

  it("sends an error and ends the session when Deepgram fails to connect", async () => {
    await giveConsent();
    deepgramTestState.setShouldFail(true);
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = messageQueue(ws);
    await queue.next(); // session_started, sent before the Deepgram connect attempt
    expect(await queue.next()).toEqual({ type: "error", message: "Could not start transcription" });
    expect(await queue.next()).toEqual({ type: "session_ended", reason: "error" });

    await app.close();
  });
});

describe("turn-based reply loop", () => {
  function emitSpeechFinal(transcript: string): void {
    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript }] },
    });
  }

  it("generates a reply and streams synthesized audio after end_of_turn", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    emitSpeechFinal("hello Kalli");

    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "transcript", text: "hello Kalli", isFinal: true },
    });
    expect(await queue.next()).toEqual({ kind: "json", message: { type: "end_of_turn" } });
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_text_delta", text: "Nice job!" },
    });
    expect(await queue.next()).toEqual({ kind: "binary", data: Buffer.from([1, 2, 3]) });
    expect(await queue.next()).toEqual({ kind: "binary", data: Buffer.from([4, 5]) });
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_text", text: "Nice job!" },
    });
    expect(await queue.next()).toEqual({ kind: "json", message: { type: "reply_audio_end" } });

    expect(ttsTestState.getCalls()).toEqual(["Nice job!"]);

    ws.terminate();
    await app.close();
  });

  it("persists a Turn record with the transcript and reply", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    const started = (await queue.next()) as {
      kind: "json";
      message: { type: "session_started"; sessionId: string };
    };
    const sessionId = started.message.sessionId;

    emitSpeechFinal("hello Kalli");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    // The Turn is persisted before reply_text is sent, so waiting for it is enough.
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_text", text: "Nice job!" },
    });

    const rows = await db.select().from(turns).where(eq(turns.sessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.transcript).toBe("hello Kalli");
    expect(rows[0]?.reply).toBe("Nice job!");

    // Drain the rest of the pipeline (reply_audio_end) so no fire-and-forget work from this
    // test is still in flight once afterEach tears down the database rows.
    await queue.next();

    ws.terminate();
    await app.close();
  });

  it("concatenates multiple finalized segments into one turn transcript", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: true,
      speech_final: false,
      channel: { alternatives: [{ transcript: "hello" }] },
    });
    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: "Kalli" }] },
    });

    await queue.next(); // transcript "hello"
    await queue.next(); // transcript "Kalli"
    await queue.next(); // end_of_turn

    expect(llmTestState.getCalls()).toEqual([[{ role: "user", content: "hello Kalli" }]]);

    // Drain the rest of the pipeline before tearing down, per the note above.
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_text
    await queue.next(); // reply_audio_end

    ws.terminate();
    await app.close();
  });

  it("still signals end_of_turn on speech_final when no finalized segment was buffered", async () => {
    // Deepgram's own docs show speech_final: true arriving on a result where is_final is still
    // false — the client needs to know the turn ended even though nothing made it into the
    // transcript buffer yet, so it doesn't treat the mic as still "listening".
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: false,
      speech_final: true,
      channel: { alternatives: [{ transcript: "hello" }] },
    });

    await queue.next(); // transcript
    expect(await queue.next()).toEqual({ kind: "json", message: { type: "end_of_turn" } });
    expect(llmTestState.getCalls()).toHaveLength(0);

    ws.terminate();
    await app.close();
  });

  it("falls back to UtteranceEnd to end the turn when speech_final never arrives", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: true,
      speech_final: false,
      channel: { alternatives: [{ transcript: "hello Kalli" }] },
    });
    await queue.next(); // transcript

    deepgramTestState.getLatest()?.emitMessage({ type: "UtteranceEnd" });

    expect(await queue.next()).toEqual({ kind: "json", message: { type: "end_of_turn" } });
    expect(llmTestState.getCalls()).toEqual([[{ role: "user", content: "hello Kalli" }]]);

    // Drain the rest of the pipeline before tearing down, per the note above.
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_text
    await queue.next(); // reply_audio_end

    ws.terminate();
    await app.close();
  });

  it("ignores UtteranceEnd when speech_final already ended the turn", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    emitSpeechFinal("hello Kalli");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn

    deepgramTestState.getLatest()?.emitMessage({ type: "UtteranceEnd" });

    // Drain the one legitimate turn's pipeline.
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_text
    await queue.next(); // reply_audio_end

    // Give any wrongly-triggered second turn a chance to start before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(llmTestState.getCalls()).toHaveLength(1);

    ws.terminate();
    await app.close();
  });

  it("does not send a second end_of_turn for the UtteranceEnd that follows speech_final", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    emitSpeechFinal("hello Kalli");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn

    deepgramTestState.getLatest()?.emitMessage({ type: "UtteranceEnd" });

    // Drain the one legitimate turn's pipeline.
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_text
    await queue.next(); // reply_audio_end

    // Nothing else should arrive — in particular, no second end_of_turn from the UtteranceEnd.
    const raceResult = await Promise.race([
      queue.next().then((frame) => ({ timedOut: false, frame })),
      new Promise((resolve) => setTimeout(resolve, 50)).then(() => ({
        timedOut: true,
        frame: undefined,
      })),
    ]);
    expect(raceResult).toEqual({ timedOut: true, frame: undefined });

    ws.terminate();
    await app.close();
  });

  /** Drains one turn: transcript, end_of_turn, reply_text_delta, 2 audio chunks, reply_text, audio_end. */
  async function drainOneTurn(queue: { next: () => Promise<QueuedFrame> }): Promise<void> {
    for (let i = 0; i < 7; i++) await queue.next();
  }

  it("carries recent conversation history into the next turn's reply", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    emitSpeechFinal("first turn");
    await drainOneTurn(queue);

    emitSpeechFinal("second turn");
    await drainOneTurn(queue);

    expect(llmTestState.getCalls()[1]).toEqual([
      { role: "user", content: "first turn" },
      { role: "assistant", content: "Nice job!" },
      { role: "user", content: "second turn" },
    ]);

    ws.terminate();
    await app.close();
  });

  it("sends an error and keeps the session alive when reply generation fails", async () => {
    await giveConsent();
    llmTestState.setReplyImpl(async () => {
      throw new Error("Anthropic unavailable");
    });
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    const started = (await queue.next()) as {
      kind: "json";
      message: { type: "session_started"; sessionId: string };
    };
    const sessionId = started.message.sessionId;

    emitSpeechFinal("hello Kalli");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "error", message: "Could not generate a reply" },
    });

    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.endedAt).toBeNull();
    expect(await db.select().from(turns).where(eq(turns.sessionId, sessionId))).toHaveLength(0);

    ws.terminate();
    await app.close();
  });

  it("sends an error and persists the Turn even when audio synthesis fails", async () => {
    await giveConsent();
    ttsTestState.setSynthesizeImpl(async () => {
      throw new Error("ElevenLabs unavailable");
    });
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    const started = (await queue.next()) as {
      kind: "json";
      message: { type: "session_started"; sessionId: string };
    };
    const sessionId = started.message.sessionId;

    emitSpeechFinal("hello Kalli");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_text", text: "Nice job!" },
    });
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "error", message: "Could not synthesize reply audio" },
    });
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_interrupted", reason: "error" },
    });

    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.endedAt).toBeNull();

    const rows = await db.select().from(turns).where(eq(turns.sessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reply).toBe("Nice job!");

    ws.terminate();
    await app.close();
  });
});

describe("two-pass correction pipeline", () => {
  function emitSpeechFinal(transcript: string): void {
    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript }] },
    });
  }

  const sampleError: DetectedError = {
    category: "subject_verb_agreement",
    original: "she go",
    corrected: "she goes",
    explanation: "Third-person singular verbs take an -s ending.",
  };

  it("sends pass 1's transcript to analyzeErrors and its output into generateReply", async () => {
    await giveConsent();
    llmTestState.setAnalyzeImpl(async () => [sampleError]);
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    emitSpeechFinal("she go to school");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_text
    await queue.next(); // reply_audio_end

    expect(llmTestState.getAnalyzeCalls()).toEqual(["she go to school"]);
    expect(llmTestState.getReplyErrorArgs()).toEqual([[sampleError]]);

    ws.terminate();
    await app.close();
  });

  it("persists detected errors linked to the Turn record", async () => {
    await giveConsent();
    llmTestState.setAnalyzeImpl(async () => [sampleError]);
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    const started = (await queue.next()) as {
      kind: "json";
      message: { type: "session_started"; sessionId: string };
    };
    const sessionId = started.message.sessionId;

    emitSpeechFinal("she go to school");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_text
    await queue.next(); // reply_audio_end

    const [turn] = await db.select().from(turns).where(eq(turns.sessionId, sessionId));
    expect(turn).toBeDefined();
    const rows = await db.select().from(turnErrors).where(eq(turnErrors.turnId, turn!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(sampleError);

    ws.terminate();
    await app.close();
  });

  it("persists no error rows and generates a plain reply when no errors are detected", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    const started = (await queue.next()) as {
      kind: "json";
      message: { type: "session_started"; sessionId: string };
    };
    const sessionId = started.message.sessionId;

    emitSpeechFinal("hello Kalli");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_text
    await queue.next(); // reply_audio_end

    expect(llmTestState.getReplyErrorArgs()).toEqual([[]]);

    const [turn] = await db.select().from(turns).where(eq(turns.sessionId, sessionId));
    expect(await db.select().from(turnErrors).where(eq(turnErrors.turnId, turn!.id))).toHaveLength(
      0,
    );

    ws.terminate();
    await app.close();
  });

  it("sends an error and does not persist a Turn when error analysis fails", async () => {
    await giveConsent();
    llmTestState.setAnalyzeImpl(async () => {
      throw new Error("Anthropic unavailable");
    });
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    const started = (await queue.next()) as {
      kind: "json";
      message: { type: "session_started"; sessionId: string };
    };
    const sessionId = started.message.sessionId;

    emitSpeechFinal("hello Kalli");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "error", message: "Could not analyze your speech" },
    });

    expect(llmTestState.getCalls()).toHaveLength(0);
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.endedAt).toBeNull();
    expect(await db.select().from(turns).where(eq(turns.sessionId, sessionId))).toHaveLength(0);

    ws.terminate();
    await app.close();
  });
});

describe("correction text panel", () => {
  function emitSpeechFinal(transcript: string): void {
    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript }] },
    });
  }

  const sampleError: DetectedError = {
    category: "subject_verb_agreement",
    original: "she go",
    corrected: "she goes",
    explanation: "Third-person singular verbs take an -s ending.",
  };

  it("sends the turn's error list to the client before reply_text", async () => {
    await giveConsent();
    llmTestState.setAnalyzeImpl(async () => [sampleError]);
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    emitSpeechFinal("she go to school");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk

    const turnErrorsFrame = await queue.next();
    expect(turnErrorsFrame).toEqual({
      kind: "json",
      message: {
        type: "turn_errors",
        turnId: expect.any(String),
        createdAt: expect.any(String),
        errors: [{ ...sampleError, id: expect.any(String), hasClip: true, bookmarked: false }],
      },
    });

    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_text", text: "Nice job!" },
    });

    ws.terminate();
    await app.close();
  });

  it("sends no turn_errors message when a turn has no detected errors", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    emitSpeechFinal("hello Kalli");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk

    // Straight to reply_text — no turn_errors frame in between.
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_text", text: "Nice job!" },
    });

    ws.terminate();
    await app.close();
  });
});

describe("L1-driven interference hints", () => {
  function emitSpeechFinal(transcript: string): void {
    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript }] },
    });
  }

  /** Drains one turn: transcript, end_of_turn, reply_text_delta, 2 audio chunks, reply_text, audio_end. */
  async function drainOneTurn(queue: { next: () => Promise<QueuedFrame> }): Promise<void> {
    for (let i = 0; i < 7; i++) await queue.next();
  }

  it("passes the user's stored L1 to analyzeErrors", async () => {
    await giveConsent("mandarin");
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    emitSpeechFinal("she go to school");
    await drainOneTurn(queue);

    expect(llmTestState.getAnalyzeL1Calls()).toEqual(["mandarin"]);

    ws.terminate();
    await app.close();
  });

  it('passes "other" to analyzeErrors for a user with no L1-specific hints', async () => {
    await giveConsent("other");
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    emitSpeechFinal("she go to school");
    await drainOneTurn(queue);

    expect(llmTestState.getAnalyzeL1Calls()).toEqual(["other"]);

    ws.terminate();
    await app.close();
  });
});

describe("session limits", () => {
  afterEach(() => {
    delete process.env["DAILY_SESSION_CAP"];
    delete process.env["MAX_SESSION_DURATION_MINUTES"];
  });

  it("sends an error message and closes a new session once the daily session cap is reached", async () => {
    await giveConsent();
    process.env["DAILY_SESSION_CAP"] = "1";
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    await messageQueue(ws).next(); // session_started
    ws.terminate();

    const ws2 = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue2 = messageQueue(ws2);

    expect(await queue2.next()).toEqual({
      type: "error",
      message: "Daily session limit reached",
    });
    await new Promise<void>((resolve) => ws2.on("close", resolve));

    expect(await db.select().from(sessions)).toHaveLength(1);

    await app.close();
  });

  it("automatically ends an active session with reason max_duration once it hits the limit", async () => {
    await giveConsent();
    process.env["MAX_SESSION_DURATION_MINUTES"] = "0.0005"; // 30ms
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = messageQueue(ws);
    const { sessionId } = (await queue.next()) as { type: "session_started"; sessionId: string };

    expect(await queue.next()).toEqual({ type: "session_ended", reason: "max_duration" });

    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.endReason).toBe("max_duration");
    expect(row?.endedAt).not.toBeNull();

    await app.close();
  });
});

describe("usage metering", () => {
  function emitSpeechFinal(transcript: string): void {
    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript }] },
    });
  }

  it("records LLM token usage and ElevenLabs characters synthesized for a turn", async () => {
    await giveConsent();
    llmTestState.setAnalyzeUsage({ inputTokens: 20, outputTokens: 4 });
    llmTestState.setReplyUsage({ inputTokens: 30, outputTokens: 12 });
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    const started = (await queue.next()) as {
      kind: "json";
      message: { type: "session_started"; sessionId: string };
    };
    const sessionId = started.message.sessionId;

    emitSpeechFinal("hello Kalli");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_text
    await queue.next(); // reply_audio_end

    const [usage] = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.sessionId, sessionId));
    expect(usage).toMatchObject({
      analysisInputTokens: 20,
      analysisOutputTokens: 4,
      replyInputTokens: 30,
      replyOutputTokens: 12,
      elevenlabsCharacters: "Nice job!".length,
    });

    ws.terminate();
    await app.close();
  });

  it("accumulates usage across multiple turns in the same session", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    const started = (await queue.next()) as {
      kind: "json";
      message: { type: "session_started"; sessionId: string };
    };
    const sessionId = started.message.sessionId;

    for (let i = 0; i < 2; i++) {
      emitSpeechFinal("hello Kalli");
      for (let j = 0; j < 6; j++) await queue.next();
    }

    const [usage] = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.sessionId, sessionId));
    expect(usage?.analysisInputTokens).toBe(16);
    expect(usage?.replyInputTokens).toBe(20);
    expect(usage?.elevenlabsCharacters).toBe(2 * "Nice job!".length);

    ws.terminate();
    await app.close();
  });

  it("records elapsed session duration as deepgram seconds when the session ends", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = messageQueue(ws);
    const { sessionId } = (await queue.next()) as { type: "session_started"; sessionId: string };

    ws.send(JSON.stringify({ type: "end_session" }));
    await queue.next(); // session_ended

    const [usage] = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.sessionId, sessionId));
    expect(usage?.deepgramSeconds).toBeGreaterThanOrEqual(0);

    await app.close();
  });
});

describe("audio clip capture + storage", () => {
  function emitSpeechFinal(transcript: string): void {
    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript }] },
    });
  }

  const sampleError: DetectedError = {
    category: "subject_verb_agreement",
    original: "she go",
    corrected: "she goes",
    explanation: "Third-person singular verbs take an -s ending.",
  };

  it("uploads the turn's audio as one clip and links it to every detected error", async () => {
    await giveConsent();
    llmTestState.setAnalyzeImpl(async () => [sampleError]);
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    const started = (await queue.next()) as {
      kind: "json";
      message: { type: "session_started"; sessionId: string };
    };
    const sessionId = started.message.sessionId;

    ws.send(Buffer.from([1, 2, 3]));
    ws.send(Buffer.from([4, 5]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    emitSpeechFinal("she go to school");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // turn_errors
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_text
    await queue.next(); // reply_audio_end

    const uploads = storageTestState.getUploads();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.data).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(uploads[0]?.contentType).toBe("audio/webm");

    const [turn] = await db.select().from(turns).where(eq(turns.sessionId, sessionId));
    const rows = await db.select().from(turnErrors).where(eq(turnErrors.turnId, turn!.id));
    expect(rows[0]?.audioClipId).toBeTypeOf("string");

    ws.terminate();
    await app.close();
  });

  it("does not upload a clip for a turn with no detected errors", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    ws.send(Buffer.from([1, 2, 3]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    emitSpeechFinal("hello Kalli");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_text
    await queue.next(); // reply_audio_end

    expect(storageTestState.getUploads()).toHaveLength(0);

    ws.terminate();
    await app.close();
  });

  it("resets the audio buffer between turns", async () => {
    await giveConsent();
    llmTestState.setAnalyzeImpl(async () => [sampleError]);
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    // Each turn has a detected error (sampleError), so an extra turn_errors frame is sent too:
    // transcript, end_of_turn, turn_errors, reply_text_delta, 2 audio chunks, reply_text, audio_end.
    ws.send(Buffer.from([1]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    emitSpeechFinal("first turn");
    for (let i = 0; i < 8; i++) await queue.next();

    ws.send(Buffer.from([2]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    emitSpeechFinal("second turn");
    for (let i = 0; i < 8; i++) await queue.next();

    const uploads = storageTestState.getUploads();
    expect(uploads).toHaveLength(2);
    expect(uploads[0]?.data).toEqual(Buffer.from([1]));
    expect(uploads[1]?.data).toEqual(Buffer.from([2]));

    ws.terminate();
    await app.close();
  });
});

describe("barge-in support", () => {
  function emitSpeechFinal(transcript: string): void {
    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript }] },
    });
  }

  /** Recognized speech arriving mid-utterance — the confirmed signal that drives barge-in. */
  function emitInterimSpeech(transcript: string): void {
    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: false,
      speech_final: false,
      channel: { alternatives: [{ transcript }] },
    });
  }

  it("does nothing when speech starts and no reply is in progress", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    // With no turn in flight, recognized speech is just an ordinary transcript — no
    // reply_interrupted is queued ahead of it.
    emitInterimSpeech("hi");
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "transcript", text: "hi", isFinal: false },
    });

    ws.terminate();
    await app.close();
  });

  it("stops the in-flight TTS stream and notifies the client on barge-in", async () => {
    await giveConsent();
    let resolveContinue: () => void = () => {};
    const continueSignal = new Promise<void>((resolve) => {
      resolveContinue = resolve;
    });
    async function* pausableChunks(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1]);
      await continueSignal;
      yield new Uint8Array([2]);
    }
    ttsTestState.setSynthesizeImpl(async () => pausableChunks());

    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    emitSpeechFinal("hello Kalli");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    expect(await queue.next()).toEqual({ kind: "binary", data: Buffer.from([1]) });
    await queue.next(); // reply_text — sent independently of (and racing) the audio side

    emitInterimSpeech("wait");
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_interrupted", reason: "barge_in" },
    });

    resolveContinue();

    // The next real signal (the barge-in speech being processed as a new turn, asserted in
    // the test below) is what proves chunk 2 and reply_audio_end were never sent — there's
    // nothing further to drain from the interrupted turn.

    ws.terminate();
    await app.close();
  });

  it("leaves the already-persisted Turn record untouched when a reply is interrupted mid-TTS", async () => {
    await giveConsent();
    let resolveContinue: () => void = () => {};
    const continueSignal = new Promise<void>((resolve) => {
      resolveContinue = resolve;
    });
    async function* pausableChunks(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1]);
      await continueSignal;
      yield new Uint8Array([2]);
    }
    ttsTestState.setSynthesizeImpl(async () => pausableChunks());

    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    const started = (await queue.next()) as {
      kind: "json";
      message: { type: "session_started"; sessionId: string };
    };
    const sessionId = started.message.sessionId;

    emitSpeechFinal("hello Kalli");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk 1
    await queue.next(); // reply_text — the Turn is persisted before this is sent

    emitInterimSpeech("wait");
    await queue.next(); // reply_interrupted
    resolveContinue();
    // Give the interrupted turn's continuation a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const rows = await db.select().from(turns).where(eq(turns.sessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.transcript).toBe("hello Kalli");
    expect(rows[0]?.reply).toBe("Nice job!");

    ws.terminate();
    await app.close();
  });

  it("processes barge-in speech as a new turn, not waiting on the interrupted reply", async () => {
    await giveConsent();
    let resolveFirstReply: (value: string) => void = () => {};
    const firstReplyPromise = new Promise<string>((resolve) => {
      resolveFirstReply = resolve;
    });
    llmTestState.setReplyImpl(async () => firstReplyPromise);

    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    emitSpeechFinal("first turn");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn

    // The new turn's own recognized speech is itself the confirmation of barge-in — no
    // separate signal needed. It's processed immediately, without waiting for the
    // interrupted turn's still-pending LLM call to resolve.
    llmTestState.setReplyImpl(async () => "Nice job!");
    emitSpeechFinal("second turn");
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_interrupted", reason: "barge_in" },
    });
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "transcript", text: "second turn", isFinal: true },
    });
    expect(await queue.next()).toEqual({ kind: "json", message: { type: "end_of_turn" } });
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_text_delta", text: "Nice job!" },
    });
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_text", text: "Nice job!" },
    });

    resolveFirstReply("Stale reply");

    ws.terminate();
    await app.close();
  });

  it("does not persist a Turn record for a reply interrupted before it was saved", async () => {
    await giveConsent();
    let resolveFirstReply: (value: string) => void = () => {};
    const firstReplyPromise = new Promise<string>((resolve) => {
      resolveFirstReply = resolve;
    });
    llmTestState.setReplyImpl(async () => firstReplyPromise);

    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    const started = (await queue.next()) as {
      kind: "json";
      message: { type: "session_started"; sessionId: string };
    };
    const sessionId = started.message.sessionId;

    emitSpeechFinal("first turn");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn

    emitInterimSpeech("wait");
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_interrupted", reason: "barge_in" },
    });

    resolveFirstReply("Stale reply");
    // Give the interrupted turn's continuation a tick to run (and confirm it doesn't persist).
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await db.select().from(turns).where(eq(turns.sessionId, sessionId))).toHaveLength(0);

    ws.terminate();
    await app.close();
  });

  it("treats speech as barge-in even after the reply has finished streaming, while it's still playing", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    emitSpeechFinal("hello Kalli");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_text
    await queue.next(); // reply_audio_end — the pipeline has fully finished; nothing is "active"
    // server-side except the client's not-yet-reported playback of the audio it just received.

    emitInterimSpeech("wait");
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_interrupted", reason: "barge_in" },
    });

    ws.terminate();
    await app.close();
  });

  it("does not treat speech as barge-in once the client reports playback ended", async () => {
    await giveConsent();
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started

    emitSpeechFinal("hello Kalli");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_text
    await queue.next(); // reply_audio_end

    ws.send(JSON.stringify({ type: "reply_playback_ended" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    emitSpeechFinal("second turn");
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "transcript", text: "second turn", isFinal: true },
    });
    expect(await queue.next()).toEqual({ kind: "json", message: { type: "end_of_turn" } });

    // Drain the rest of the pipeline (reply_text + 2 audio chunks + reply_audio_end) so no
    // fire-and-forget work from this test is still in flight once afterEach tears down.
    await queue.next();
    await queue.next();
    await queue.next();
    await queue.next();

    ws.terminate();
    await app.close();
  });
});
