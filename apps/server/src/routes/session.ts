import type {
  ClientToServerMessage,
  DetectedError,
  L1,
  PersistedError,
  ServerToClientMessage,
  SessionEndReason,
} from "@callie/types";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AsyncQueue } from "../asyncQueue.js";
import { storeTurnClip } from "../audioClips.js";
import { getAuthenticatedUserId } from "../auth.js";
import { db } from "../db/client.js";
import { profiles, sessions, turnErrors, turns } from "../db/schema.js";
import type { DeepgramConnection } from "../deepgram.js";
import { openDeepgramConnection } from "../deepgram.js";
import type { AnalysisResult, ConversationMessage, TokenUsage } from "../llm.js";
import { getLLMProvider } from "../llm.js";
import { getMaxSessionDurationMs, hasReachedDailySessionCap } from "../sessionLimits.js";
import { splitSentences } from "../sentenceSplitter.js";
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
  /** `hasClip` is always false here — it's only known once `maybeStoreClip` runs afterward. */
  errors: PersistedError[];
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
    let persistedErrors: PersistedError[] = [];
    if (errors.length > 0) {
      const inserted = await tx
        .insert(turnErrors)
        .values(errors.map((error) => ({ turnId: turn.id, ...error })))
        .returning();
      persistedErrors = inserted.map((row) => ({
        id: row.id,
        category: row.category,
        original: row.original,
        corrected: row.corrected,
        explanation: row.explanation,
        hasClip: false,
        bookmarked: false,
      }));
    }
    return { id: turn.id, createdAt: turn.createdAt, errors: persistedErrors };
  });
}

/**
 * Uploads the turn's audio as a clip, best-effort — a failed upload shouldn't fail the turn.
 * Returns whether the upload succeeded, so callers know whether to advertise a clip as playable.
 */
async function maybeStoreClip(
  turn: PersistedTurn,
  audio: Buffer,
  shouldStore: boolean,
  log: FastifyBaseLogger,
): Promise<boolean> {
  if (!shouldStore) return false;
  try {
    await storeTurnClip(turn.id, audio);
    return true;
  } catch (error) {
    log.error(error, "Failed to store audio clip");
    return false;
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
       * Whether the current turn has already been flushed (by `speech_final` or `UtteranceEnd`).
       * Deepgram can send both for the same turn — this makes the second one a true no-op,
       * including its `send({ type: "end_of_turn" })`, not just the `handleTurn` call. Reset the
       * instant new transcript activity arrives, marking the next turn as open again.
       */
      let turnFlushed = false;

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

      /**
       * Starts pass 2 (streamed) and the sentence-pipelined TTS synthesis running concurrently:
       * as each complete sentence is detected in the reply's token stream, it's handed to the TTS
       * queue so synthesis for sentence N overlaps with the model still generating sentence N+1,
       * rather than waiting for the full reply before synthesis starts at all (ticket 17). TTS
       * calls themselves still run one at a time, in sentence order — only generation and
       * synthesis overlap, not synthesis with itself — so audio never needs reordering on the
       * wire.
       *
       * Resolves as soon as generation itself finishes, independent of how far behind audio
       * synthesis is — a reply already fully generated is valid (and worth persisting/sending)
       * regardless of whether its audio is still playing out, still synthesizing, or gets
       * interrupted by barge-in partway through. `waitForAudio` lets the caller separately await
       * the (already-running) audio side once it's ready to, without blocking on it up front.
       * A failure in generation itself has no valid text to fall back on, so the whole turn is
       * abandoned instead.
       */
      async function streamReplyWithPipelinedTTS(
        errors: DetectedError[],
        aborted: () => boolean,
      ): Promise<
        | { textFailed: true }
        | {
            textFailed: false;
            replyText: string;
            usage: TokenUsage;
            waitForAudio: () => Promise<{ audioFailed: boolean }>;
          }
      > {
        // Pass a snapshot: conversationHistory keeps mutating (the assistant reply below, future
        // turns) after this call is made, and callers/tests may hold onto this array.
        const replyStream = getLLMProvider().generateReply([...conversationHistory], errors);
        const sentenceQueue = new AsyncQueue<string>();
        let sentenceBuffer = "";
        let replyText = "";
        let audioFailed = false;

        async function consumeAudio(): Promise<void> {
          try {
            for await (const sentence of sentenceQueue) {
              if (aborted()) return;
              // Characters are billed by ElevenLabs as soon as the call is made, regardless of
              // whether the resulting stream is fully consumed.
              await recordUsage(sessionId, { elevenlabsCharacters: sentence.length });
              const audioChunks = await getTTSProvider().synthesize(sentence);
              for await (const chunk of audioChunks) {
                if (aborted()) return;
                socket.send(Buffer.from(chunk));
              }
            }
          } catch (error) {
            audioFailed = true;
            request.log.error(error, "Failed to synthesize reply audio");
          }
        }

        // Starts immediately and keeps running in the background — awaited later via
        // `waitForAudio`, not here, so a slow/interrupted audio side never delays the text side.
        const audioTask = consumeAudio();

        try {
          for await (const delta of replyStream.textStream) {
            if (aborted()) break;
            replyText += delta;
            send({ type: "reply_text_delta", text: delta });
            const { sentences, remainder } = splitSentences(sentenceBuffer + delta);
            sentenceBuffer = remainder;
            for (const sentence of sentences) sentenceQueue.push(sentence);
          }
          const finalSentence = sentenceBuffer.trim();
          if (finalSentence && !aborted()) sentenceQueue.push(finalSentence);
        } catch (error) {
          request.log.error(error, "Failed to generate reply");
          sentenceQueue.close();
          await audioTask;
          return { textFailed: true };
        }
        sentenceQueue.close();

        let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
        try {
          usage = await replyStream.usage;
        } catch (error) {
          request.log.error(error, "Failed to read reply token usage");
        }
        return {
          textFailed: false,
          replyText,
          usage,
          waitForAudio: async () => {
            await audioTask;
            return { audioFailed };
          },
        };
      }

      /** Sends the paired error + interrupted-audio signal for a mid-pipeline failure. */
      function sendPipelineFailure(message: string): void {
        if (ended) return;
        send({ type: "error", message });
        send({ type: "reply_interrupted", reason: "error" });
      }

      /** Runs the LLM reply + TTS pipeline for one finished user turn. */
      async function handleTurn(transcript: string, audio: Buffer): Promise<void> {
        if (activeTurn) return;
        const myTurn: ActiveTurn = { interrupted: false };
        activeTurn = myTurn;
        const aborted = (): boolean => ended || myTurn.interrupted;
        // Set once the audio side is running and cleared once it's explicitly awaited below.
        // This isn't what makes barge-in start the next turn's audio immediately — barge-in
        // clears `activeTurn` synchronously in the Deepgram message handler regardless of this —
        // it's just hygiene for *this* call's own background work: an early return between text
        // succeeding and the explicit `await waitForAudio()` (e.g. `ended` becoming true mid
        // persist) would otherwise leave `consumeAudio` running unawaited past this function's
        // own completion.
        let pendingAudio: (() => Promise<{ audioFailed: boolean }>) | undefined;
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

          const result = await streamReplyWithPipelinedTTS(errors, aborted);
          if (result.textFailed) {
            sendPipelineFailure("Could not generate a reply");
            return;
          }
          const { replyText, usage, waitForAudio } = result;
          pendingAudio = waitForAudio;
          // The vendor calls already ran and were billed regardless of what happens next (abort,
          // persistence failure), so token usage is recorded unconditionally here.
          await recordUsage(sessionId, {
            analysisInputTokens: analysis.usage.inputTokens,
            analysisOutputTokens: analysis.usage.outputTokens,
            replyInputTokens: usage.inputTokens,
            replyOutputTokens: usage.outputTokens,
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
          const hasClip = await maybeStoreClip(
            persistedTurn,
            audio,
            hasErrors && hasConsent,
            request.log,
          );
          if (aborted()) return;
          if (hasErrors) {
            send({
              type: "turn_errors",
              turnId: persistedTurn.id,
              createdAt: persistedTurn.createdAt.toISOString(),
              errors: persistedTurn.errors.map((error) => ({ ...error, hasClip })),
            });
          }
          send({ type: "reply_text", text: replyText });

          pendingAudio = undefined;
          const { audioFailed } = await waitForAudio();
          if (audioFailed) {
            sendPipelineFailure("Could not synthesize reply audio");
            return;
          }
          if (!aborted()) {
            replyPlaying = true;
            send({ type: "reply_audio_end" });
          }
        } finally {
          if (pendingAudio) await pendingAudio();
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
       * audio. Called from both `speech_final` and the `UtteranceEnd` fallback below; `turnFlushed`
       * is what makes calling this from both a true no-op the second time — including suppressing
       * the duplicate `end_of_turn` — so a `speech_final` immediately followed by `UtteranceEnd`,
       * which Deepgram's docs say can happen, doesn't double-process the turn or leave the client
       * with two typing indicators (one stuck forever once the real reply lands in the other).
       */
      function flushTurn(): void {
        if (turnFlushed) return;
        turnFlushed = true;
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
        turnFlushed = false;

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
          send({ type: "reply_interrupted", reason: "barge_in" });
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
