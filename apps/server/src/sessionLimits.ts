import { and, eq, gte } from "drizzle-orm";
import { db } from "./db/client.js";
import { sessions } from "./db/schema.js";

const DEFAULT_MAX_SESSION_DURATION_MINUTES = 15;
const DEFAULT_DAILY_SESSION_CAP = 10;

function positiveIntFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Max wall-clock duration a session may run before the server auto-ends it. */
export function getMaxSessionDurationMs(): number {
  return (
    positiveIntFromEnv("MAX_SESSION_DURATION_MINUTES", DEFAULT_MAX_SESSION_DURATION_MINUTES) *
    60_000
  );
}

/** Soft cap on how many sessions a single user may start per UTC day. */
export function getDailySessionCap(): number {
  return positiveIntFromEnv("DAILY_SESSION_CAP", DEFAULT_DAILY_SESSION_CAP);
}

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Whether `userId` has already started as many sessions today (UTC) as the daily cap allows. */
export async function hasReachedDailySessionCap(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.clerkUserId, userId), gte(sessions.startedAt, startOfTodayUtc())));
  return rows.length >= getDailySessionCap();
}
