import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { audioClips, sessions, turnErrors, turns } from "../db/schema.js";

vi.mock("@clerk/fastify", () => ({
  clerkPlugin: async () => {},
  getAuth: (request: { headers: { authorization?: string } }) => {
    if (request.headers.authorization === "Bearer error-test-user") {
      return { isAuthenticated: true, userId: "error-test-user" };
    }
    if (request.headers.authorization === "Bearer other-user") {
      return { isAuthenticated: true, userId: "other-user" };
    }
    return { isAuthenticated: false, userId: null };
  },
}));

const storageTestState = vi.hoisted(() => {
  const downloads: string[] = [];
  return {
    reset: (): void => {
      downloads.length = 0;
    },
    downloads,
    getStorageProvider: vi.fn(() => ({
      upload: async () => {},
      delete: async () => {},
      download: async (key: string) => {
        downloads.push(key);
        return Buffer.from(`clip-bytes-for-${key}`);
      },
    })),
  };
});

vi.mock("../storage.js", () => ({ getStorageProvider: storageTestState.getStorageProvider }));

const ttsTestState = vi.hoisted(() => {
  async function* defaultChunks(): AsyncIterable<Uint8Array> {
    yield new Uint8Array([1, 2, 3]);
    yield new Uint8Array([4, 5]);
  }
  const calls: string[] = [];
  return {
    reset: (): void => {
      calls.length = 0;
    },
    calls,
    getTTSProvider: vi.fn(() => ({
      synthesize: async (text: string) => {
        calls.push(text);
        return defaultChunks();
      },
    })),
  };
});

vi.mock("../tts.js", () => ({ getTTSProvider: ttsTestState.getTTSProvider }));

// vitest hoists imports above vi.mock calls, so app.js must be imported after the mocks above.
const { buildApp } = await import("../app.js");

async function insertError(options: {
  clerkUserId?: string;
  withClip?: boolean;
}): Promise<{ errorId: string }> {
  const [session] = await db
    .insert(sessions)
    .values({ clerkUserId: options.clerkUserId ?? "error-test-user" })
    .returning();
  const [turn] = await db
    .insert(turns)
    .values({ sessionId: session!.id, transcript: "she go", reply: "Nice!" })
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
      category: "subject_verb_agreement",
      original: "she go",
      corrected: "she goes",
      explanation: "Third-person singular verbs take an -s ending.",
      audioClipId,
    })
    .returning();
  return { errorId: row!.id };
}

afterEach(async () => {
  storageTestState.reset();
  ttsTestState.reset();
  await db.delete(turnErrors);
  await db.delete(turns);
  await db.delete(sessions);
  await db.delete(audioClips);
});

describe("GET /api/errors/:errorId/clip", () => {
  it("returns 401 when not authenticated", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/errors/anything/clip" });
    expect(response.statusCode).toBe(401);
  });

  it("returns 404 when the error has no stored clip", async () => {
    const app = buildApp();
    const { errorId } = await insertError({ withClip: false });

    const response = await app.inject({
      method: "GET",
      url: `/api/errors/${errorId}/clip`,
      headers: { authorization: "Bearer error-test-user" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for an error owned by a different user", async () => {
    const app = buildApp();
    const { errorId } = await insertError({ clerkUserId: "someone-else", withClip: true });

    const response = await app.inject({
      method: "GET",
      url: `/api/errors/${errorId}/clip`,
      headers: { authorization: "Bearer error-test-user" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for a nonexistent error id", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/errors/00000000-0000-0000-0000-000000000000/clip",
      headers: { authorization: "Bearer error-test-user" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("streams the stored clip's bytes for its owner", async () => {
    const app = buildApp();
    const { errorId } = await insertError({ withClip: true });

    const response = await app.inject({
      method: "GET",
      url: `/api/errors/${errorId}/clip`,
      headers: { authorization: "Bearer error-test-user" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("audio/webm");
    expect(response.rawPayload.toString()).toContain("clip-bytes-for-clips/");
  });
});

describe("GET /api/errors/:errorId/target-audio", () => {
  it("returns 401 when not authenticated", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/errors/anything/target-audio" });
    expect(response.statusCode).toBe(401);
  });

  it("returns 404 for an error owned by a different user", async () => {
    const app = buildApp();
    const { errorId } = await insertError({ clerkUserId: "someone-else" });

    const response = await app.inject({
      method: "GET",
      url: `/api/errors/${errorId}/target-audio`,
      headers: { authorization: "Bearer error-test-user" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("synthesizes and streams the error's corrected text, without persisting it", async () => {
    const app = buildApp();
    const { errorId } = await insertError({});

    const response = await app.inject({
      method: "GET",
      url: `/api/errors/${errorId}/target-audio`,
      headers: { authorization: "Bearer error-test-user" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("audio/mpeg");
    expect(response.rawPayload).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(ttsTestState.calls).toEqual(["she goes"]);
    expect(storageTestState.downloads).toEqual([]);
  });

  it("triggers a fresh synthesis on every request, with no caching", async () => {
    const app = buildApp();
    const { errorId } = await insertError({});

    await app.inject({
      method: "GET",
      url: `/api/errors/${errorId}/target-audio`,
      headers: { authorization: "Bearer error-test-user" },
    });
    await app.inject({
      method: "GET",
      url: `/api/errors/${errorId}/target-audio`,
      headers: { authorization: "Bearer error-test-user" },
    });

    expect(ttsTestState.calls).toEqual(["she goes", "she goes"]);
  });
});

describe("ownership across the two endpoints", () => {
  it("lets a different authenticated user hit the routes but never see another user's data", async () => {
    const app = buildApp();
    const { errorId } = await insertError({ withClip: true });

    const clipResponse = await app.inject({
      method: "GET",
      url: `/api/errors/${errorId}/clip`,
      headers: { authorization: "Bearer other-user" },
    });
    const targetResponse = await app.inject({
      method: "GET",
      url: `/api/errors/${errorId}/target-audio`,
      headers: { authorization: "Bearer other-user" },
    });

    expect(clipResponse.statusCode).toBe(404);
    expect(targetResponse.statusCode).toBe(404);
  });
});

describe("PATCH /api/errors/:errorId/bookmark", () => {
  it("returns 401 when not authenticated", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "PATCH", url: "/api/errors/anything/bookmark" });
    expect(response.statusCode).toBe(401);
  });

  it("returns 404 when the error has no stored clip", async () => {
    const app = buildApp();
    const { errorId } = await insertError({ withClip: false });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/errors/${errorId}/bookmark`,
      headers: { authorization: "Bearer error-test-user" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for an error owned by a different user", async () => {
    const app = buildApp();
    const { errorId } = await insertError({ clerkUserId: "someone-else", withClip: true });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/errors/${errorId}/bookmark`,
      headers: { authorization: "Bearer error-test-user" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for a nonexistent error id", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/errors/00000000-0000-0000-0000-000000000000/bookmark",
      headers: { authorization: "Bearer error-test-user" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("bookmarks an unbookmarked clip and returns the new state", async () => {
    const app = buildApp();
    const { errorId } = await insertError({ withClip: true });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/errors/${errorId}/bookmark`,
      headers: { authorization: "Bearer error-test-user" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ bookmarked: true });
    const [clip] = await db.select().from(audioClips);
    expect(clip?.bookmarked).toBe(true);
  });

  it("un-bookmarks an already-bookmarked clip on a second toggle", async () => {
    const app = buildApp();
    const { errorId } = await insertError({ withClip: true });

    await app.inject({
      method: "PATCH",
      url: `/api/errors/${errorId}/bookmark`,
      headers: { authorization: "Bearer error-test-user" },
    });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/errors/${errorId}/bookmark`,
      headers: { authorization: "Bearer error-test-user" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ bookmarked: false });
    const [clip] = await db.select().from(audioClips);
    expect(clip?.bookmarked).toBe(false);
  });

  it("un-bookmarking restores the original expiry rather than resetting it", async () => {
    const app = buildApp();
    const { errorId } = await insertError({ withClip: true });
    const [clipBefore] = await db.select().from(audioClips);
    const originalExpiry = clipBefore?.expiresAt.getTime();

    await app.inject({
      method: "PATCH",
      url: `/api/errors/${errorId}/bookmark`,
      headers: { authorization: "Bearer error-test-user" },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/errors/${errorId}/bookmark`,
      headers: { authorization: "Bearer error-test-user" },
    });

    const [clipAfter] = await db.select().from(audioClips);
    expect(clipAfter?.expiresAt.getTime()).toBe(originalExpiry);
  });
});
