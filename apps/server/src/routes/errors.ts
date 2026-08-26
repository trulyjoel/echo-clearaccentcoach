import { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireUserId } from "../auth.js";
import { db } from "../db/client.js";
import { audioClips, sessions, turnErrors, turns } from "../db/schema.js";
import { getStorageProvider } from "../storage.js";
import { getTTSProvider } from "../tts.js";

interface OwnedError {
  corrected: string;
  storageKey: string | null;
  audioClipId: string | null;
}

/** Loads a turn error by id, scoped to `userId` via its turn's session — undefined if not found/owned. */
async function findOwnedError(errorId: string, userId: string): Promise<OwnedError | undefined> {
  const [row] = await db
    .select({
      corrected: turnErrors.corrected,
      storageKey: audioClips.storageKey,
      audioClipId: audioClips.id,
    })
    .from(turnErrors)
    .innerJoin(turns, eq(turnErrors.turnId, turns.id))
    .innerJoin(sessions, eq(turns.sessionId, sessions.id))
    .leftJoin(audioClips, eq(turnErrors.audioClipId, audioClips.id))
    .where(and(eq(turnErrors.id, errorId), eq(sessions.clerkUserId, userId)));

  return row;
}

export function registerErrorRoutes(app: FastifyInstance): void {
  app.get("/api/errors/:errorId/clip", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return reply;

    const { errorId } = request.params as { errorId: string };
    const error = await findOwnedError(errorId, userId);
    if (!error?.storageKey) {
      return reply.status(404).send({ error: "No audio clip for this error" });
    }

    const clip = await getStorageProvider().download(error.storageKey);
    return reply.type("audio/webm").send(clip);
  });

  // Not persisted (per ticket 12) — synthesized fresh on every request and streamed straight
  // through from the TTS provider's chunk iterable rather than buffered.
  app.get("/api/errors/:errorId/target-audio", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return reply;

    const { errorId } = request.params as { errorId: string };
    const error = await findOwnedError(errorId, userId);
    if (!error) return reply.status(404).send({ error: "Error not found" });

    const { audio } = await getTTSProvider().synthesize(error.corrected);
    return reply.type("audio/mpeg").send(Readable.from(audio));
  });

  // Toggles rather than takes an explicit target state — the review UI only ever needs "flip
  // it". Un-bookmarking leaves `expiresAt` untouched, so the clip resumes counting down from its
  // original creation time rather than getting a fresh 90-day window (ticket 13).
  app.patch("/api/errors/:errorId/bookmark", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return reply;

    const { errorId } = request.params as { errorId: string };
    const error = await findOwnedError(errorId, userId);
    if (!error?.audioClipId) {
      return reply.status(404).send({ error: "No audio clip for this error" });
    }

    // Flips atomically in the database (rather than reading `bookmarked` then writing its
    // negation) so two concurrent toggles for the same clip can't both read the same starting
    // value and race to write the same result, silently losing one of the toggles.
    const [updated] = await db
      .update(audioClips)
      .set({ bookmarked: sql`not ${audioClips.bookmarked}` })
      .where(eq(audioClips.id, error.audioClipId))
      .returning({ bookmarked: audioClips.bookmarked });

    if (!updated) {
      return reply.status(404).send({ error: "No audio clip for this error" });
    }
    return reply.send({ bookmarked: updated.bookmarked });
  });
}
