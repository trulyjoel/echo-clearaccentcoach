import type {
  ClientToServerMessage,
  DetectedError,
  L1,
  ServerToClientMessage,
  SessionEndReason,
} from "@callie/types";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { storeTurnClip } from "../audioClips.js";
import { getAuthenticatedUserId } from "../auth.js";
import { db } from "../db/client.js";
import { profiles, sessions, turnErrors, turns } from "../db/schema.js";
import type { DeepgramConnection } from "../deepgram.js";
import { openDeepgramConnection } from "../deepgram.js";
import type { AnalysisResult, ConversationMessage, ReplyResult } from "../llm.js";
import { getLLMProvider } from "../llm.js";
import { getMaxSessionDurationMs, hasReachedDailySessionCap } from "../sessionLimits.js";
import { getTTSProvider } from "../tts.js";
import { ensureUsageRecord, recordUsage } from "../usage.js";

/**
 * Rejects the WebSocket upgrade (with a normal HTTP status) unless the user is authenticated.
 *
 * Consent and the daily session cap are deliberately NOT checked here: an HTTP-level rejection
 * of the upgrade gives the browser's WebSocket API no way to surface the reason (`ws.onerror`
 * carries no status or body), so the client can only show a generic "Connection error." The
 * session handler checks those instead, once the socket is open, so it can send a real
 * `{type: "error"}` message the client can display.
 */
async function requireAuthenticatedUser(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  bridgeQueryToken(request);
  if (!getAuthenticatedUserId(request)) {
    await reply.code(401).send({ error: "Not authenticated" });
  }
}

/** Browsers can't set custom headers on a WebSocket handshake, so the client passes the Clerk token as a query param. */
function bridgeQueryToken(request: FastifyRequest): void {
  const { token } = request.query as { token?: string };
  if (token && !request.headers.authorization) {
    request.headers.authorization = `Bearer ${token}`;
  }
}

interface PersistedTurn {
  id: string;
  createdAt: Date;
}

/** Persists a turn and its detected errors together in one transaction. */
async function persistTurn(
  sessionId: string,
  transcript: string,
  replyText: string,
  errors: DetectedError[],
): Promise<PersistedTurn> {
  return db.transaction(async (tx) => {
    const [turn] = await tx
      .insert(turns)
      .values({ sessionId, transcript, reply: replyText })
      .returning();
    if (!turn) throw new Error("Failed to insert turn record");
    if (errors.length > 0) {
      await tx.insert(turnErrors).values(errors.map((error) => ({ turnId: turn.id, ...error })));
    }
    return turn;
  });
}

/** Uploads the turn's audio as a clip, best-effort — a failed upload shouldn't fail the turn. */
async function maybeStoreClip(
  turn: PersistedTurn,
  audio: Buffer,
  shouldStore: boolean,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!shouldStore) return;
  try {
    await storeTurnClip(turn.id, audio);
  } catch (error) {
    log.error(error, "Failed to store audio clip");
  }
}

export function registerSessionRoutes(app: FastifyInstance): void {
  app.get(
    "/api/session",
    { websocket: true, preValidation: requireAuthenticatedUser },
    async (socket, request) => {
      function send(message: ServerToClientMessage): void {
        socket.send(JSON.stringify(message));
      }
      function reject(message: string): void {
        send({ type: "error", message });
        socket.close();
      }

      // preValidation already confirmed the user is authenticated.
      const userId = getAuthenticatedUserId(request);
      if (!userId) {
        throw new Error("Unreachable: preValidation should have rejected this request");
      }

      const [profile] = await db.select().from(profiles).where(eq(profiles.clerkUserId, userId));
      if (!profile?.l1 || !profile.consentGivenAt) {
        reject("Recording consent required");
        return;
      }
      if (await hasReachedDailySessionCap(userId)) {
        reject("Daily session limit reached");
        return;
      }
      const l1: L1 = profile.l1;
      const hasConsent = Boolean(profile.consentGivenAt);

      const [session] = await db.insert(sessions).values({ clerkUserId: userId }).returning();
      if (!session) throw new Error("Failed to insert session record");
      const sessionId = session.id;
      const sessionStartedAt = session.startedAt;
      await ensureUsageRecord(sessionId);
      send({ type: "session_started", sessionId });

      let deepgramConnection: DeepgramConnection | undefined;
      let ended = false;
      const maxDurationTimer = setTimeout(() => {
        void endSession("max_duration");
      }, getMaxSessionDurationMs());
      async function endSession(reason: SessionEndReason): Promise<void> {
        if (ended) return;
        ended = true;
        clearTimeout(maxDurationTimer);
        deepgramConnection?.close();
        const endedAt = new Date();
        await db
          .update(sessions)
          .set({ endedAt, endReason: reason })
          .where(eq(sessions.id, sessionId));
        const durationSeconds = Math.round((endedAt.getTime() - sessionStartedAt.getTime()) / 1000);
        await recordUsage(sessionId, { deepgramSeconds: durationSeconds });
        send({ type: "session_ended", reason });
        socket.close();
      }

      const conversationHistory: ConversationMessage[] = [];
      let turnTranscriptParts: string[] = [];
      let turnAudioChunks: Buffer[] = [];

      /**
       * Tracks the turn whose LLM/TTS pipeline is currently running, so a subsequent confirmed
       * transcript (the user talking over a reply) can mark it interrupted — the pipeline checks
       * `interrupted` at each await boundary and bails without sending more to the client.
       * `activeTurn` is nulled out immediately on barge-in (rather than waiting for the
       * interrupted pipeline's own cleanup) so the next turn isn't held up by it.
       */
      interface ActiveTurn {
        interrupted: boolean;
      }
      let activeTurn: ActiveTurn | null = null;

      /**
       * Whether the client is (or is about to be) audibly playing a reply. `activeTurn` alone
       * only covers the pipeline's run — it's cleared as soon as the audio bytes finish
       * streaming, well before the client finishes playing them — so this extends the
       * interruptible window through actual client-side playback, ending only when the client
       * reports `reply_playback_ended`.
       */
      let replyPlaying = false;

      /** Runs the LLM reply + TTS pipeline for one finished user turn. */
      async function handleTurn(transcript: string, audio: Buffer): Promise<void> {
        if (activeTurn) return;
        const myTurn: ActiveTurn = { interrupted: false };
        activeTurn = myTurn;
        const aborted = (): boolean => ended || myTurn.interrupted;
        try {
          conversationHistory.push({ role: "user", content: transcript });

          let analysis: AnalysisResult;
          try {
            analysis = await getLLMProvider().analyzeErrors(transcript, l1);
          } catch (error) {
            request.log.error(error, "Failed to analyze errors");
            if (!ended) send({ type: "error", message: "Could not analyze your speech" });
            return;
          }
          const errors = analysis.errors;
          if (aborted()) return;

          let reply: ReplyResult;
          try {
            // Pass a snapshot: conversationHistory keeps mutating (the assistant reply below,
            // future turns) after this call is made, and callers/tests may hold onto this array.
            reply = await getLLMProvider().generateReply([...conversationHistory], errors);
          } catch (error) {
            request.log.error(error, "Failed to generate reply");
            if (!ended) send({ type: "error", message: "Could not generate a reply" });
            return;
          }
          const replyText = reply.text;
          // The vendor calls already ran and were billed regardless of what happens next
          // (abort, persistence failure), so token usage is recorded unconditionally here.
          await recordUsage(sessionId, {
            analysisInputTokens: analysis.usage.inputTokens,
            analysisOutputTokens: analysis.usage.outputTokens,
            replyInputTokens: reply.usage.inputTokens,
            replyOutputTokens: reply.usage.outputTokens,
          });
          if (aborted()) return;
          conversationHistory.push({ role: "assistant", content: replyText });

          let persistedTurn: PersistedTurn;
          try {
            persistedTurn = await persistTurn(sessionId, transcript, replyText, errors);
          } catch (error) {
            request.log.error(error, "Failed to persist turn");
            if (!ended) send({ type: "error", message: "Could not save this turn" });
            return;
          }
          // The consent check above already guarantees consent for every session that reaches
          // here — `hasConsent` is defense-in-depth against that gate ever changing.
          const hasErrors = errors.length > 0;
          await maybeStoreClip(persistedTurn, audio, hasErrors && hasConsent, request.log);
          if (aborted()) return;
          if (hasErrors) {
            send({
              type: "turn_errors",
              turnId: persistedTurn.id,
              createdAt: persistedTurn.createdAt.toISOString(),
              errors,
            });
          }
          send({ type: "reply_text", text: replyText });

          try {
            // Characters are billed by ElevenLabs as soon as the call is made, regardless of
            // whether the resulting stream is fully consumed.
            await recordUsage(sessionId, { elevenlabsCharacters: replyText.length });
            const audioChunks = await getTTSProvider().synthesize(replyText);
            for await (const chunk of audioChunks) {
              if (aborted()) return;
              socket.send(Buffer.from(chunk));
            }
            if (!aborted()) {
              replyPlaying = true;
              send({ type: "reply_audio_end" });
            }
          } catch (error) {
            request.log.error(error, "Failed to synthesize reply audio");
            if (!aborted()) send({ type: "error", message: "Could not synthesize reply audio" });
          }
        } finally {
          if (activeTurn === myTurn) activeTurn = null;
        }
      }

      try {
        deepgramConnection = await openDeepgramConnection();
      } catch (error) {
        request.log.error(error, "Failed to open Deepgram connection");
        send({ type: "error", message: "Could not start transcription" });
        await endSession("error");
        return;
      }

      /**
       * Ends the current turn and hands it to `handleTurn`, draining the buffered transcript and
       * audio. Called from both `speech_final` and the `UtteranceEnd` fallback below; the buffer
       * being empty (already drained) is what makes calling this from both a no-op the second
       * time, so a `speech_final` immediately followed by `UtteranceEnd` — which Deepgram's docs
       * say can happen — doesn't double-process the turn.
       */
      function flushTurn(): void {
        send({ type: "end_of_turn" });
        const turnTranscript = turnTranscriptParts.join(" ").trim();
        turnTranscriptParts = [];
        const turnAudio = Buffer.concat(turnAudioChunks);
        turnAudioChunks = [];
        if (turnTranscript) void handleTurn(turnTranscript, turnAudio);
      }

      deepgramConnection.on("message", (data) => {
        // Endpointing's speech_final is a known-flaky signal (Deepgram's own docs: background
        // noise/VAD interaction can prevent it from ever firing) — UtteranceEnd is Deepgram's
        // documented independent fallback for exactly that case, so a turn doesn't get stuck
        // waiting on a signal that never arrives.
        if (data.type === "UtteranceEnd") {
          flushTurn();
          return;
        }
        if (data.type !== "Results") return;
        const transcript = data.channel.alternatives[0]?.transcript ?? "";
        if (!transcript) return;

        // A non-empty transcript arriving while a turn's pipeline is running, or its reply is
        // still audibly playing, is real barge-in — unlike a bare VAD "speech started" ping,
        // background noise can't produce recognized words, so this can't false-trigger on
        // breathing or room noise the way VAD alone can.
        if (activeTurn || replyPlaying) {
          if (activeTurn) {
            activeTurn.interrupted = true;
            activeTurn = null;
          }
          replyPlaying = false;
          send({ type: "reply_interrupted" });
        }

        send({ type: "transcript", text: transcript, isFinal: data.is_final ?? false });
        if (data.is_final) turnTranscriptParts.push(transcript);

        if (data.speech_final) flushTurn();
      });

      deepgramConnection.on("error", (error) => {
        request.log.error(error, "Deepgram connection error");
        send({ type: "error", message: "Transcription error" });
        void endSession("error");
      });

      deepgramConnection.on("close", () => {
        void endSession("error");
      });

      socket.on("message", (message: Buffer, isBinary: boolean) => {
        if (isBinary) {
          deepgramConnection.sendMedia(message);
          turnAudioChunks.push(message);
          return;
        }

        let parsed: ClientToServerMessage;
        try {
          parsed = JSON.parse(message.toString()) as ClientToServerMessage;
        } catch {
          return;
        }
        if (parsed.type === "end_session") {
          void endSession("user_ended");
        }
        if (parsed.type === "reply_playback_ended") {
          replyPlaying = false;
        }
      });

      socket.on("close", () => {
        void endSession("disconnected");
      });
    },
  );
}
