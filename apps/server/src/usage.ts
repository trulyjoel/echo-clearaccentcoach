import { eq, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { usageRecords } from "./db/schema.js";

export interface UsageDelta {
  deepgramSeconds: number;
  elevenlabsCharacters: number;
  analysisInputTokens: number;
  analysisOutputTokens: number;
  replyInputTokens: number;
  replyOutputTokens: number;
}

const ZERO_USAGE: UsageDelta = {
  deepgramSeconds: 0,
  elevenlabsCharacters: 0,
  analysisInputTokens: 0,
  analysisOutputTokens: 0,
  replyInputTokens: 0,
  replyOutputTokens: 0,
};

/** Creates the zeroed usage row a session's turns/duration will accumulate into. */
export async function ensureUsageRecord(sessionId: string): Promise<void> {
  await db.insert(usageRecords).values({ sessionId });
}

/**
 * Adds `delta` onto the session's running usage totals. Fields omitted from `delta` default to
 * 0, so this doubles as a "set once" call for fields (like `deepgramSeconds`) only ever reported
 * a single time per session.
 */
export async function recordUsage(sessionId: string, delta: Partial<UsageDelta>): Promise<void> {
  const full = { ...ZERO_USAGE, ...delta };
  await db
    .update(usageRecords)
    .set({
      deepgramSeconds: sql`${usageRecords.deepgramSeconds} + ${full.deepgramSeconds}`,
      elevenlabsCharacters: sql`${usageRecords.elevenlabsCharacters} + ${full.elevenlabsCharacters}`,
      analysisInputTokens: sql`${usageRecords.analysisInputTokens} + ${full.analysisInputTokens}`,
      analysisOutputTokens: sql`${usageRecords.analysisOutputTokens} + ${full.analysisOutputTokens}`,
      replyInputTokens: sql`${usageRecords.replyInputTokens} + ${full.replyInputTokens}`,
      replyOutputTokens: sql`${usageRecords.replyOutputTokens} + ${full.replyOutputTokens}`,
      updatedAt: new Date(),
    })
    .where(eq(usageRecords.sessionId, sessionId));
}
