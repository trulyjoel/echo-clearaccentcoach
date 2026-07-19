import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { audioClips, sessions, turnErrors, turns } from "../db/schema.js";

vi.mock("@clerk/fastify", () => ({
  clerkPlugin: async () => {},
  getAuth: (request: { headers: { authorization?: string } }) => {
    if (request.headers.authorization === "Bearer history-test-user") {
      return { isAuthenticated: true, userId: "history-test-user" };
    }
    if (request.headers.authorization === "Bearer other-user") {
      return { isAuthenticated: true, userId: "other-user" };
    }
    return { isAuthenticated: false, userId: null };
  },
}));

// vitest hoists imports above vi.mock calls, so app.js must be imported after the mocks above.
const { buildApp } = await import("../app.js");

async function insertSession(options: {
  clerkUserId?: string;
  startedAt?: Date;
  endedAt?: Date | null;
  endReason?: "user_ended" | "disconnected" | "error" | "max_duration" | null;
}): Promise<{ sessionId: string }> {
  const [session] = await db
    .insert(sessions)
    .values({
      clerkUserId: options.clerkUserId ?? "history-test-user",
      startedAt: options.startedAt,
      endedAt: options.endedAt,
      endReason: options.endReason,
    })
    .returning();
  return { sessionId: session!.id };
}

async function insertTurnWithError(
  sessionId: string,
  options: { category?: "word_order" | "verb_tense_aspect"; withClip?: boolean } = {},
): Promise<{ turnId: string; errorId: string }> {
  const [turn] = await db
    .insert(turns)
    .values({ sessionId, transcript: "she go", reply: "Nice!" })
    .returning();

  let audioClipId: string | undefined;
  if (options.withClip) {
    const [clip] = await db
      .insert(audioClips)
      .values({ storageKey: `clips/${turn!.id}.webm`, expiresAt: new Date(Date.now() + 1000) })
      .returning();
    audioClipId = clip!.id;
  }

  const [row] = await db
    .insert(turnErrors)
    .values({
      turnId: turn!.id,
      category: options.category ?? "subject_verb_agreement",
      original: "she go",
      corrected: "she goes",
      explanation: "Third-person singular verbs take an -s ending.",
      audioClipId,
    })
    .returning();
  return { turnId: turn!.id, errorId: row!.id };
}

afterEach(async () => {
  await db.delete(turnErrors);
  await db.delete(turns);
  await db.delete(sessions);
  await db.delete(audioClips);
});

describe("GET /api/history/sessions", () => {
  it("returns 401 when not authenticated", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/history/sessions" });
    expect(response.statusCode).toBe(401);
  });

  it("returns an empty list for a user with no sessions", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/history/sessions",
      headers: { authorization: "Bearer history-test-user" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("lists only the requesting user's sessions, newest first, with turn/error counts", async () => {
    const app = buildApp();
    const { sessionId: older } = await insertSession({
      startedAt: new Date("2026-07-01T10:00:00Z"),
      endedAt: new Date("2026-07-01T10:10:00Z"),
      endReason: "user_ended",
    });
    await insertTurnWithError(older);
    const { sessionId: newer } = await insertSession({
      startedAt: new Date("2026-07-10T10:00:00Z"),
      endedAt: null,
      endReason: null,
    });
    await insertSession({ clerkUserId: "someone-else" });

    const response = await app.inject({
      method: "GET",
      url: "/api/history/sessions",
      headers: { authorization: "Bearer history-test-user" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: newer,
        startedAt: "2026-07-10T10:00:00.000Z",
        endedAt: null,
        endReason: null,
        turnCount: 0,
        errorCount: 0,
      },
      {
        id: older,
        startedAt: "2026-07-01T10:00:00.000Z",
        endedAt: "2026-07-01T10:10:00.000Z",
        endReason: "user_ended",
        turnCount: 1,
        errorCount: 1,
      },
    ]);
  });
});

describe("GET /api/history/sessions/:sessionId/errors", () => {
  it("returns 401 when not authenticated", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/history/sessions/anything/errors",
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 404 for a nonexistent session id", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/history/sessions/00000000-0000-0000-0000-000000000000/errors",
      headers: { authorization: "Bearer history-test-user" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 rather than erroring for a malformed session id", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/history/sessions/not-a-uuid/errors",
      headers: { authorization: "Bearer history-test-user" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for a session owned by a different user", async () => {
    const app = buildApp();
    const { sessionId } = await insertSession({ clerkUserId: "someone-else" });

    const response = await app.inject({
      method: "GET",
      url: `/api/history/sessions/${sessionId}/errors`,
      headers: { authorization: "Bearer history-test-user" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns the session summary and its flagged errors", async () => {
    const app = buildApp();
    const { sessionId } = await insertSession({
      startedAt: new Date("2026-07-01T10:00:00Z"),
      endedAt: new Date("2026-07-01T10:10:00Z"),
      endReason: "user_ended",
    });
    const { errorId } = await insertTurnWithError(sessionId, { withClip: true });

    const response = await app.inject({
      method: "GET",
      url: `/api/history/sessions/${sessionId}/errors`,
      headers: { authorization: "Bearer history-test-user" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.session).toEqual({
      id: sessionId,
      startedAt: "2026-07-01T10:00:00.000Z",
      endedAt: "2026-07-01T10:10:00.000Z",
      endReason: "user_ended",
      turnCount: 1,
      errorCount: 1,
    });
    expect(body.errors).toEqual([
      expect.objectContaining({
        id: errorId,
        category: "subject_verb_agreement",
        original: "she go",
        corrected: "she goes",
        explanation: "Third-person singular verbs take an -s ending.",
      }),
    ]);
  });
});

describe("GET /api/history/errors/summary", () => {
  it("returns 401 when not authenticated", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/history/errors/summary" });
    expect(response.statusCode).toBe(401);
  });

  it("returns an empty list for a user with no errors", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/history/errors/summary",
      headers: { authorization: "Bearer history-test-user" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("aggregates error counts by category across all of the user's sessions, excluding other users'", async () => {
    const app = buildApp();
    const { sessionId: sessionA } = await insertSession({});
    const { sessionId: sessionB } = await insertSession({});
    await insertTurnWithError(sessionA, { category: "word_order" });
    await insertTurnWithError(sessionA, { category: "word_order" });
    await insertTurnWithError(sessionB, { category: "verb_tense_aspect" });

    const { sessionId: otherSession } = await insertSession({ clerkUserId: "someone-else" });
    await insertTurnWithError(otherSession, { category: "word_order" });

    const response = await app.inject({
      method: "GET",
      url: "/api/history/errors/summary",
      headers: { authorization: "Bearer history-test-user" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { category: "word_order", count: 2 },
      { category: "verb_tense_aspect", count: 1 },
    ]);
  });
});

describe("ownership across the three endpoints", () => {
  it("lets a different authenticated user hit the routes but never see another user's data", async () => {
    const app = buildApp();
    const { sessionId } = await insertSession({});
    await insertTurnWithError(sessionId);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/history/sessions",
      headers: { authorization: "Bearer other-user" },
    });
    const summaryResponse = await app.inject({
      method: "GET",
      url: "/api/history/errors/summary",
      headers: { authorization: "Bearer other-user" },
    });

    expect(listResponse.json()).toEqual([]);
    expect(summaryResponse.json()).toEqual([]);
  });
});
