import { eq, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { usageRecords } from "./db/schema.js";

export interface UsageDelta {
  deepgramSeconds: number;
  deepgramModel: string;
  elevenlabsCharacters: number;
  elevenlabsModel: string;
  analysisInputTokens: number;
  analysisOutputTokens: number;
  analysisModel: string;
  replyInputTokens: number;
  replyOutputTokens: number;
  replyModel: string;
}

const ZERO_COUNTS = {
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
 * Adds `delta`'s counts onto the session's running usage totals and, for model-name fields,
 * overwrites with whatever value `delta` provides. Count fields omitted from `delta` default to
 * 0, so this doubles as a "set once" call for fields (like `deepgramSeconds`) only ever reported
 * a single time per session. Model fields are omitted from the update entirely when absent from
 * `delta`, rather than overwritten with a default, since a vendor call always reports its own
 * model alongside its usage and there's nothing to zero them to.
 */
export async function recordUsage(sessionId: string, delta: Partial<UsageDelta>): Promise<void> {
  const counts = { ...ZERO_COUNTS, ...delta };
  await db
    .update(usageRecords)
    .set({
      deepgramSeconds: sql`${usageRecords.deepgramSeconds} + ${counts.deepgramSeconds}`,
      elevenlabsCharacters: sql`${usageRecords.elevenlabsCharacters} + ${counts.elevenlabsCharacters}`,
      analysisInputTokens: sql`${usageRecords.analysisInputTokens} + ${counts.analysisInputTokens}`,
      analysisOutputTokens: sql`${usageRecords.analysisOutputTokens} + ${counts.analysisOutputTokens}`,
      replyInputTokens: sql`${usageRecords.replyInputTokens} + ${counts.replyInputTokens}`,
      replyOutputTokens: sql`${usageRecords.replyOutputTokens} + ${counts.replyOutputTokens}`,
      updatedAt: new Date(),
      ...(delta.deepgramModel !== undefined && { deepgramModel: delta.deepgramModel }),
      ...(delta.elevenlabsModel !== undefined && { elevenlabsModel: delta.elevenlabsModel }),
      ...(delta.analysisModel !== undefined && { analysisModel: delta.analysisModel }),
      ...(delta.replyModel !== undefined && { replyModel: delta.replyModel }),
    })
    .where(eq(usageRecords.sessionId, sessionId));
}
