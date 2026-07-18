import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "./db/client.js";
import { audioClips, sessions, turnErrors, turns } from "./db/schema.js";

const storageTestState = vi.hoisted(() => {
  const uploads: Array<{ key: string; data: Buffer; contentType: string }> = [];
  const deletes: string[] = [];
  return {
    uploads,
    deletes,
    reset: (): void => {
      uploads.length = 0;
      deletes.length = 0;
    },
    getStorageProvider: vi.fn(() => ({
      upload: async (key: string, data: Buffer, contentType: string) => {
        uploads.push({ key, data, contentType });
      },
      delete: async (key: string) => {
        deletes.push(key);
      },
    })),
  };
});

vi.mock("./storage.js", () => ({ getStorageProvider: storageTestState.getStorageProvider }));

// vitest hoists imports above vi.mock calls, so audioClips.js must be imported after the mock above.
const { storeTurnClip, cleanupExpiredClips } = await import("./audioClips.js");

async function insertTurn(): Promise<{ turnId: string }> {
  const [session] = await db.insert(sessions).values({ clerkUserId: "clip-test-user" }).returning();
  const [turn] = await db
    .insert(turns)
    .values({ sessionId: session!.id, transcript: "hi", reply: "hello" })
    .returning();
  return { turnId: turn!.id };
}

afterEach(async () => {
  storageTestState.reset();
  await db.delete(turnErrors);
  await db.delete(turns);
  await db.delete(sessions);
  await db.delete(audioClips);
});

describe("storeTurnClip", () => {
  it("uploads the audio as webm/opus and links it to every error in the turn", async () => {
    const { turnId } = await insertTurn();
    await db.insert(turnErrors).values([
      { turnId, category: "word_order", original: "a", corrected: "b", explanation: "x" },
      { turnId, category: "article_usage", original: "c", corrected: "d", explanation: "y" },
    ]);

    await storeTurnClip(turnId, Buffer.from([1, 2, 3]));

    expect(storageTestState.uploads).toHaveLength(1);
    expect(storageTestState.uploads[0]?.contentType).toBe("audio/webm");
    expect(storageTestState.uploads[0]?.data).toEqual(Buffer.from([1, 2, 3]));

    const rows = await db.select().from(turnErrors).where(eq(turnErrors.turnId, turnId));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.audioClipId).toBeTypeOf("string");
    expect(rows[0]?.audioClipId).toBe(rows[1]?.audioClipId);
  });

  it("sets a 90-day expiry on the stored clip", async () => {
    const { turnId } = await insertTurn();
    await db
      .insert(turnErrors)
      .values([
        { turnId, category: "word_order", original: "a", corrected: "b", explanation: "x" },
      ]);

    const before = Date.now();
    await storeTurnClip(turnId, Buffer.from([1]));

    const [row] = await db.select().from(turnErrors).where(eq(turnErrors.turnId, turnId));
    const [clip] = await db.select().from(audioClips).where(eq(audioClips.id, row!.audioClipId!));
    const expectedExpiry = before + 90 * 24 * 60 * 60 * 1000;
    expect(clip?.expiresAt.getTime()).toBeGreaterThan(expectedExpiry - 5000);
    expect(clip?.expiresAt.getTime()).toBeLessThan(expectedExpiry + 5000);
  });
});

describe("cleanupExpiredClips", () => {
  it("deletes expired, non-bookmarked clips from storage and the database", async () => {
    const [expired] = await db
      .insert(audioClips)
      .values({ storageKey: "clips/expired.webm", expiresAt: new Date(Date.now() - 1000) })
      .returning();
    const [future] = await db
      .insert(audioClips)
      .values({ storageKey: "clips/future.webm", expiresAt: new Date(Date.now() + 1000) })
      .returning();

    const removed = await cleanupExpiredClips();

    expect(removed).toBe(1);
    expect(storageTestState.deletes).toEqual(["clips/expired.webm"]);
    expect(await db.select().from(audioClips).where(eq(audioClips.id, expired!.id))).toHaveLength(
      0,
    );
    expect(await db.select().from(audioClips).where(eq(audioClips.id, future!.id))).toHaveLength(1);
  });

  it("skips bookmarked clips even if expired", async () => {
    const [bookmarked] = await db
      .insert(audioClips)
      .values({
        storageKey: "clips/bookmarked.webm",
        expiresAt: new Date(Date.now() - 1000),
        bookmarked: true,
      })
      .returning();

    const removed = await cleanupExpiredClips();

    expect(removed).toBe(0);
    expect(storageTestState.deletes).toEqual([]);
    expect(
      await db.select().from(audioClips).where(eq(audioClips.id, bookmarked!.id)),
    ).toHaveLength(1);
  });
});
