import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "./db/client.js";
import { audioClips, turnErrors } from "./db/schema.js";
import { getStorageProvider } from "./storage.js";

const CLIP_RETENTION_DAYS = 90;

/**
 * Uploads a turn's audio (already Opus-encoded — the browser records via MediaRecorder with
 * `audio/webm;codecs=opus`, so no separate transcoding step is needed) as one clip shared by
 * every error detected in that turn, and links each of that turn's Error rows to it.
 *
 * Granularity is per-turn, not per-word: Deepgram's word-level timestamps aren't wired up, and
 * `audio/webm` chunks can't be sliced to an arbitrary sub-range without a demuxer/remuxer. A turn
 * is one conversational utterance (already far short of full-session audio), so this is a
 * reasonable proxy for "the segment around a flagged error" without that extra machinery.
 */
export async function storeTurnClip(turnId: string, audio: Buffer): Promise<void> {
  const key = `clips/${randomUUID()}.webm`;
  await getStorageProvider().upload(key, audio, "audio/webm");

  const expiresAt = new Date(Date.now() + CLIP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const [clip] = await db.insert(audioClips).values({ storageKey: key, expiresAt }).returning();
  if (!clip) throw new Error("Failed to insert audio clip record");

  await db.update(turnErrors).set({ audioClipId: clip.id }).where(eq(turnErrors.turnId, turnId));
}

/** Deletes expired, non-bookmarked clips from storage and the database. Returns the count removed. */
export async function cleanupExpiredClips(now = new Date()): Promise<number> {
  const expired = await db
    .select()
    .from(audioClips)
    .where(and(lt(audioClips.expiresAt, now), eq(audioClips.bookmarked, false)));

  for (const clip of expired) {
    await getStorageProvider().delete(clip.storageKey);
    await db.delete(audioClips).where(eq(audioClips.id, clip.id));
  }

  return expired.length;
}
