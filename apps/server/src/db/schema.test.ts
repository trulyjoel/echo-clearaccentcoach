import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "./client.js";
import { sessions, turnPronunciationErrors, turns } from "./schema.js";

afterEach(async () => {
  await db.delete(turnPronunciationErrors);
  await db.delete(turns);
  await db.delete(sessions);
});

describe("turnPronunciationErrors", () => {
  it("round-trips a row linked to a turn", async () => {
    const [session] = await db.insert(sessions).values({ clerkUserId: "test-user-schema" }).returning();
    if (!session) throw new Error("Failed to insert session");
    const [turn] = await db
      .insert(turns)
      .values({ sessionId: session.id, transcript: "he rike it", reply: "You'd say 'like' there." })
      .returning();
    if (!turn) throw new Error("Failed to insert turn");

    const [error] = await db
      .insert(turnPronunciationErrors)
      .values({
        turnId: turn.id,
        word: "like",
        op: "sub",
        expectedPhoneme: "L",
        spokenPhoneme: "R",
      })
      .returning();

    expect(error).toMatchObject({
      turnId: turn.id,
      word: "like",
      op: "sub",
      expectedPhoneme: "L",
      spokenPhoneme: "R",
    });

    const fetched = await db
      .select()
      .from(turnPronunciationErrors)
      .where(eq(turnPronunciationErrors.turnId, turn.id));
    expect(fetched).toHaveLength(1);
  });

  it("allows a null spokenPhoneme for a deletion", async () => {
    const [session] = await db.insert(sessions).values({ clerkUserId: "test-user-schema-2" }).returning();
    if (!session) throw new Error("Failed to insert session");
    const [turn] = await db
      .insert(turns)
      .values({ sessionId: session.id, transcript: "I as a doctor", reply: "..." })
      .returning();
    if (!turn) throw new Error("Failed to insert turn");

    const [error] = await db
      .insert(turnPronunciationErrors)
      .values({ turnId: turn.id, word: "as", op: "del", expectedPhoneme: "Z", spokenPhoneme: null })
      .returning();

    expect(error?.spokenPhoneme).toBeNull();
  });
});
