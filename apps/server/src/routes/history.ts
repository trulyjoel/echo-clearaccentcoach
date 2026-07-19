import type {
  CategoryFrequency,
  HistoryErrorEntry,
  SessionErrorsResponse,
  SessionSummary,
} from "@callie/types";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireUserId } from "../auth.js";
import { db } from "../db/client.js";
import { sessions, turnErrors, turns } from "../db/schema.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sessionSummaryColumns = {
  id: sessions.id,
  startedAt: sessions.startedAt,
  endedAt: sessions.endedAt,
  endReason: sessions.endReason,
  turnCount: sql<number>`count(distinct ${turns.id})::int`,
  errorCount: sql<number>`count(distinct ${turnErrors.id})::int`,
};

function toSessionSummary(row: {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  endReason: SessionSummary["endReason"];
  turnCount: number;
  errorCount: number;
}): SessionSummary {
  return {
    ...row,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  };
}

/** Loads one session's summary by id, scoped to `userId` — undefined if not found/owned. */
async function findOwnedSessionSummary(
  sessionId: string,
  userId: string,
): Promise<SessionSummary | undefined> {
  const [row] = await db
    .select(sessionSummaryColumns)
    .from(sessions)
    .leftJoin(turns, eq(turns.sessionId, sessions.id))
    .leftJoin(turnErrors, eq(turnErrors.turnId, turns.id))
    .where(and(eq(sessions.id, sessionId), eq(sessions.clerkUserId, userId)))
    .groupBy(sessions.id);

  return row ? toSessionSummary(row) : undefined;
}

export function registerHistoryRoutes(app: FastifyInstance): void {
  app.get("/api/history/sessions", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return reply;

    const rows = await db
      .select(sessionSummaryColumns)
      .from(sessions)
      .leftJoin(turns, eq(turns.sessionId, sessions.id))
      .leftJoin(turnErrors, eq(turnErrors.turnId, turns.id))
      .where(eq(sessions.clerkUserId, userId))
      .groupBy(sessions.id)
      .orderBy(desc(sessions.startedAt));

    const summaries: SessionSummary[] = rows.map(toSessionSummary);
    return reply.send(summaries);
  });

  app.get("/api/history/sessions/:sessionId/errors", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return reply;

    const { sessionId } = request.params as { sessionId: string };
    if (!UUID_PATTERN.test(sessionId)) {
      return reply.status(404).send({ error: "Session not found" });
    }
    const session = await findOwnedSessionSummary(sessionId, userId);
    if (!session) return reply.status(404).send({ error: "Session not found" });

    const errors: HistoryErrorEntry[] = (
      await db
        .select({
          id: turnErrors.id,
          category: turnErrors.category,
          original: turnErrors.original,
          corrected: turnErrors.corrected,
          explanation: turnErrors.explanation,
          createdAt: turnErrors.createdAt,
        })
        .from(turnErrors)
        .innerJoin(turns, eq(turnErrors.turnId, turns.id))
        .where(eq(turns.sessionId, sessionId))
        .orderBy(turnErrors.createdAt)
    ).map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));

    const response: SessionErrorsResponse = { session, errors };
    return reply.send(response);
  });

  app.get("/api/history/errors/summary", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return reply;

    const frequencies: CategoryFrequency[] = await db
      .select({ category: turnErrors.category, count: sql<number>`count(*)::int` })
      .from(turnErrors)
      .innerJoin(turns, eq(turnErrors.turnId, turns.id))
      .innerJoin(sessions, eq(turns.sessionId, sessions.id))
      .where(eq(sessions.clerkUserId, userId))
      .groupBy(turnErrors.category)
      .orderBy(desc(sql`count(*)`));

    return reply.send(frequencies);
  });
}
