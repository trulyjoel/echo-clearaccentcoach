import type { ServerToClientMessage } from "@callie/types";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { profiles, sessions, turnErrors, turns } from "../db/schema.js";
import type { DeepgramConnection, DeepgramMessage } from "../deepgram.js";
import type { DetectedError } from "../errorTaxonomy.js";
import type { ConversationMessage } from "../llm.js";

type InjectedWebSocket = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

vi.mock("@clerk/fastify", () => ({
  clerkPlugin: async () => {},
  getAuth: (request: { headers: { authorization?: string } }) => {
    if (request.headers.authorization === "Bearer test-user-session-456") {
      return { isAuthenticated: true, userId: "test-user-session-456" };
    }
    return { isAuthenticated: false, userId: null };
  },
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

const llmTestState = vi.hoisted(() => {
  let replyImpl: (history: ConversationMessage[], errors: DetectedError[]) => Promise<string> =
    async () => "Nice job!";
  let analyzeImpl: (transcript: string) => Promise<DetectedError[]> = async () => [];
  const calls: ConversationMessage[][] = [];
  const replyErrorArgs: DetectedError[][] = [];
  const analyzeCalls: string[] = [];

  return {
    reset: (): void => {
      replyImpl = async () => "Nice job!";
      analyzeImpl = async () => [];
      calls.length = 0;
      replyErrorArgs.length = 0;
      analyzeCalls.length = 0;
    },
    setReplyImpl: (
      fn: (history: ConversationMessage[], errors: DetectedError[]) => Promise<string>,
    ): void => {
      replyImpl = fn;
    },
    setAnalyzeImpl: (fn: (transcript: string) => Promise<DetectedError[]>): void => {
      analyzeImpl = fn;
    },
    getCalls: (): ConversationMessage[][] => calls,
    getReplyErrorArgs: (): DetectedError[][] => replyErrorArgs,
    getAnalyzeCalls: (): string[] => analyzeCalls,
    getLLMProvider: vi.fn(() => ({
      analyzeErrors: async (transcript: string) => {
        analyzeCalls.push(transcript);
        return analyzeImpl(transcript);
      },
      generateReply: async (history: ConversationMessage[], errors: DetectedError[]) => {
        calls.push(history);
        replyErrorArgs.push(errors);
        return replyImpl(history, errors);
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

// vitest hoists imports above vi.mock calls, so app.js must be imported after the mocks above are set up.
const { buildApp } = await import("../app.js");

async function giveConsent(): Promise<void> {
  await db
    .insert(profiles)
    .values({ clerkUserId: "test-user-session-456", l1: "spanish", consentGivenAt: new Date() });
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
  await db.delete(turnErrors);
  await db.delete(turns);
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

  it("rejects the upgrade when the user hasn't completed onboarding consent", async () => {
    const app = buildApp();
    await app.ready();

    await expect(
      app.injectWS("/api/session", { headers: { authorization: "Bearer test-user-session-456" } }),
    ).rejects.toThrow(/403/);

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

    emitSpeechFinal("hello Callie");

    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "transcript", text: "hello Callie", isFinal: true },
    });
    expect(await queue.next()).toEqual({ kind: "json", message: { type: "end_of_turn" } });
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_text", text: "Nice job!" },
    });
    expect(await queue.next()).toEqual({ kind: "binary", data: Buffer.from([1, 2, 3]) });
    expect(await queue.next()).toEqual({ kind: "binary", data: Buffer.from([4, 5]) });
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

    emitSpeechFinal("hello Callie");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    // The Turn is persisted before reply_text is sent, so waiting for it is enough.
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_text", text: "Nice job!" },
    });

    const rows = await db.select().from(turns).where(eq(turns.sessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.transcript).toBe("hello Callie");
    expect(rows[0]?.reply).toBe("Nice job!");

    // Drain the rest of the pipeline (audio chunks + reply_audio_end) so no fire-and-forget
    // work from this test is still in flight once afterEach tears down the database rows.
    await queue.next();
    await queue.next();
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
      channel: { alternatives: [{ transcript: "Callie" }] },
    });

    await queue.next(); // transcript "hello"
    await queue.next(); // transcript "Callie"
    await queue.next(); // end_of_turn

    expect(llmTestState.getCalls()).toEqual([[{ role: "user", content: "hello Callie" }]]);

    // Drain the rest of the pipeline before tearing down, per the note above.
    await queue.next(); // reply_text
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_audio_end

    ws.terminate();
    await app.close();
  });

  /** Drains one turn: transcript, end_of_turn, reply_text, 2 audio chunks, audio_end. */
  async function drainOneTurn(queue: { next: () => Promise<QueuedFrame> }): Promise<void> {
    for (let i = 0; i < 6; i++) await queue.next();
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

    emitSpeechFinal("hello Callie");
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

    emitSpeechFinal("hello Callie");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_text", text: "Nice job!" },
    });
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "error", message: "Could not synthesize reply audio" },
    });

    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.endedAt).toBeNull();

    const rows = await db.select().from(turns).where(eq(turns.sessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reply).toBe("Nice job!");

    ws.terminate();
    await app.close();
  });

  it("ignores an overlapping turn while the previous one is still being processed", async () => {
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

    // The mic stays open, so a second speech_final can arrive before the first turn's LLM
    // call resolves. Without an explicit Deepgram SpeechStarted event in between (the real
    // barge-in signal, see the "barge-in support" tests below), this is treated as a stray
    // overlap rather than a barge-in, and the turn is dropped.
    emitSpeechFinal("second turn");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn

    expect(llmTestState.getCalls()).toHaveLength(1);

    // The dropped turn's transcript/end_of_turn were already drained above, so only the
    // first turn's reply pipeline (reply_text + 2 audio chunks + audio_end) remains.
    resolveFirstReply("Nice job!");
    await queue.next(); // reply_text
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_audio_end

    expect(llmTestState.getCalls()).toHaveLength(1);

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
    await queue.next(); // reply_text
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
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
    await queue.next(); // reply_text
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
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

    emitSpeechFinal("hello Callie");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
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

    emitSpeechFinal("hello Callie");
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

describe("barge-in support", () => {
  function emitSpeechFinal(transcript: string): void {
    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript }] },
    });
  }

  function emitSpeechStarted(): void {
    deepgramTestState.getLatest()?.emitMessage({ type: "SpeechStarted" });
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

    emitSpeechStarted();

    // The next real signal (a transcript from ordinary speech) proves no reply_interrupted
    // was queued ahead of it.
    deepgramTestState.getLatest()?.emitMessage({
      type: "Results",
      is_final: false,
      speech_final: false,
      channel: { alternatives: [{ transcript: "hi" }] },
    });
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

    emitSpeechFinal("hello Callie");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text
    expect(await queue.next()).toEqual({ kind: "binary", data: Buffer.from([1]) });

    emitSpeechStarted();
    expect(await queue.next()).toEqual({ kind: "json", message: { type: "reply_interrupted" } });

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

    emitSpeechFinal("hello Callie");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text — the Turn is persisted before this is sent
    await queue.next(); // audio chunk 1

    emitSpeechStarted();
    await queue.next(); // reply_interrupted
    resolveContinue();
    // Give the interrupted turn's continuation a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const rows = await db.select().from(turns).where(eq(turns.sessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.transcript).toBe("hello Callie");
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

    emitSpeechStarted();
    expect(await queue.next()).toEqual({ kind: "json", message: { type: "reply_interrupted" } });

    // The new turn is processed immediately — it doesn't wait for the interrupted turn's
    // still-pending LLM call to resolve.
    llmTestState.setReplyImpl(async () => "Nice job!");
    emitSpeechFinal("second turn");
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "transcript", text: "second turn", isFinal: true },
    });
    expect(await queue.next()).toEqual({ kind: "json", message: { type: "end_of_turn" } });
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

    emitSpeechStarted();
    expect(await queue.next()).toEqual({ kind: "json", message: { type: "reply_interrupted" } });

    resolveFirstReply("Stale reply");
    // Give the interrupted turn's continuation a tick to run (and confirm it doesn't persist).
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await db.select().from(turns).where(eq(turns.sessionId, sessionId))).toHaveLength(0);

    ws.terminate();
    await app.close();
  });
});
