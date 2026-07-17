import type { ServerToClientMessage } from "@callie/types";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { profiles, sessions } from "../db/schema.js";
import type { DeepgramConnection, DeepgramMessage } from "../deepgram.js";

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

afterEach(async () => {
  deepgramTestState.setShouldFail(false);
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
