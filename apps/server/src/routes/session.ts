import type {
  ClientToServerMessage,
  DetectedError,
  L1,
  PersistedError,
  ProficiencyLevel,
  ServerToClientMessage,
  SessionEndReason,
} from "@kalli/types";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AsyncQueue } from "../asyncQueue.js";
import { storeTurnClip } from "../audioClips.js";
import { getAuthenticatedUserId } from "../auth.js";
import { db } from "../db/client.js";
import { profiles, sessions, turnErrors, turns } from "../db/schema.js";
import type { DeepgramConnection } from "../deepgram.js";
import { DEEPGRAM_MODEL, openDeepgramConnection } from "../deepgram.js";
import { createMarkerResolver } from "../emphasisMarkers.js";
import type { AnalysisResult, ConversationMessage, TokenUsage } from "../llm.js";
import { buildReplySystemPrompt, getLLMProvider, pickGreeting } from "../llm.js";
import { extractOnboardingAnswer, extractOnboardingConfirmation } from "../onboarding/extract.js";
import type { OnboardingResult, OnboardingState } from "../onboarding/flow.js";
import { startOnboarding, submitAnswer, submitConfirmation } from "../onboarding/flow.js";
import { containsDisallowedContent } from "../outputGuard.js";
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
  if (!getAuthenticatedUserId(request)) {
    await reply.code(401).send({ error: "Not authenticated" });
  }
}

/**
 * Well beyond any real spoken turn — a defense-in-depth cap in case Flux ever emits a
 * pathologically long transcript, so a single turn can't balloon LLM cost/latency unbounded.
 */
const MAX_TRANSCRIPT_LENGTH = 4000;

interface CompleteProfile {
  name: string;
  l1: L1;
  proficiency: ProficiencyLevel;
  context: string;
  goals: string;
}

/**
 * Narrows a `profiles` row to a `CompleteProfile` once onboarding has set every field, or `null`
 * while any are still missing — the signal used below to pick onboarding mode vs. coaching mode
 * for a connection.
 */
function toCompleteProfile(profile: typeof profiles.$inferSelect): CompleteProfile | null {
  if (!profile.name || !profile.l1 || !profile.proficiency || !profile.context || !profile.goals) {
    return null;
  }
  return {
    name: profile.name,
    l1: profile.l1,
    proficiency: profile.proficiency,
    context: profile.context,
    goals: profile.goals,
  };
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

      // The client starts streaming audio the instant its WebSocket reports open, which happens
      // as soon as the HTTP upgrade completes — well before this handler finishes its DB lookups
      // and the Deepgram handshake below. `ws`'s 'message' event isn't buffered for late
      // listeners, so registering the real handler only after that setup silently drops however
      // many chunks arrive in the meantime, always including the first one — which is the only
      // chunk carrying the WebM container header, corrupting the entire stream for every session.
      // Registering a listener immediately, before any of that async work, and queueing messages
      // until the real handler replaces it below closes that gap regardless of setup latency.
      const bufferedMessages: Array<{ message: Buffer; isBinary: boolean }> = [];
      let handleSocketMessage = (message: Buffer, isBinary: boolean): void => {
        bufferedMessages.push({ message, isBinary });
      };
      socket.on("message", (message: Buffer, isBinary: boolean) =>
        handleSocketMessage(message, isBinary),
      );

      // preValidation already confirmed the user is authenticated.
      const userId = getAuthenticatedUserId(request);
      if (!userId) {
        throw new Error("Unreachable: preValidation should have rejected this request");
      }

      const [profile] = await db.select().from(profiles).where(eq(profiles.clerkUserId, userId));
      if (!profile?.consentGivenAt) {
        reject("Recording consent required");
        return;
      }
      if (await hasReachedDailySessionCap(userId)) {
        reject("Daily session limit reached");
        return;
      }
      const hasConsent = Boolean(profile.consentGivenAt);
      const completeProfile = toCompleteProfile(profile);
      let l1: L1 | undefined = completeProfile?.l1;
      let replySystemPrompt: string | undefined = completeProfile
        ? buildReplySystemPrompt(completeProfile)
        : undefined;

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
        await recordUsage(sessionId, {
          deepgramSeconds: durationSeconds,
          deepgramModel: DEEPGRAM_MODEL,
        });
        send({ type: "session_ended", reason });
        socket.close();
      }

      const conversationHistory: ConversationMessage[] = [];
      let turnAudioChunks: Buffer[] = [];
      // The client records with a single MediaRecorder for the whole session, so only the very
      // first chunk it ever emits carries the WebM/Opus container header (EBML + Segment +
      // Tracks) — every later chunk is a headerless fragment, only meaningful appended after that
      // header. Each stored turn clip needs its own copy of it prepended to be independently
      // playable, since turnAudioChunks otherwise only holds that one turn's headerless fragments.
      let webmHeaderChunk: Buffer | undefined;

      // Flux needs a bit of audio before it's confident enough to fire StartOfTurn, so trimming
      // the clip's buffer exactly at that event clips the first fraction of a second of actual
      // speech. Keeping a short rolling pre-roll window and seeding the trimmed buffer from it
      // (rather than starting empty) absorbs that detection latency while still dropping the bulk
      // of the dead air/noise before it. ~800ms at the client's 80ms MediaRecorder timeslice.
      const PRE_ROLL_CHUNK_COUNT = 10;
      let preRollChunks: Buffer[] = [];

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
       * The onboarding flow's current state, or `null` once onboarding is complete (or was never
       * needed, because the profile was already complete at connection time). `EndOfTurn` routes
       * to `handleOnboardingTurn` while this is non-null, and to `handleTurn` once it's `null`.
       */
      let onboardingFlowState: OnboardingState | null = null;
      let initialOnboardingLine: string | null = null;
      if (!completeProfile) {
        const started = startOnboarding();
        onboardingFlowState = started.state;
        initialOnboardingLine = started.say;
      }

      /**
       * Runs `fn` under a fresh `ActiveTurn` for its whole duration, so barge-in is tracked the
       * same way for a coaching reply, the greeting, and every onboarding-flow line (question,
       * confirmation, or transition) — including, for onboarding, the extraction call before any
       * audio starts. A no-op if a turn is already active, same guard `handleTurn` uses.
       */
      async function withActiveTurn(fn: (aborted: () => boolean) => Promise<void>): Promise<void> {
        if (activeTurn) return;
        const myTurn: ActiveTurn = { interrupted: false };
        activeTurn = myTurn;
        try {
          await fn(() => ended || myTurn.interrupted);
        } finally {
          if (activeTurn === myTurn) activeTurn = null;
        }
      }

      /**
       * Speaks a fixed line of text (not an LLM stream) through the same audio pipeline a normal
       * reply uses — shared by `sendGreeting` and every onboarding-flow line. Callers wrap this in
       * `withActiveTurn` themselves, mirroring how `streamReplyWithPipelinedTTS` takes `aborted`
       * as a parameter rather than managing its own turn.
       */
      async function speakLine(text: string, aborted: () => boolean): Promise<void> {
        send({ type: "reply_text_delta", text });
        const { sentences, remainder } = splitSentences(text);
        const finalSentence = remainder.trim();
        const allSentences = finalSentence ? [...sentences, finalSentence] : sentences;
        for (const sentence of allSentences) {
          if (aborted()) return;
          try {
            const { audio, model } = await getTTSProvider().synthesize(sentence);
            await recordUsage(sessionId, { ttsCharacters: sentence.length, ttsModel: model });
            for await (const chunk of audio) {
              if (aborted()) return;
              socket.send(Buffer.from(chunk));
            }
          } catch (error) {
            request.log.error(error, "Failed to synthesize spoken line audio");
            break;
          }
        }
        if (aborted()) return;
        conversationHistory.push({ role: "assistant", content: text });
        send({ type: "reply_text", text });
        if (!aborted()) {
          replyPlaying = true;
          send({ type: "reply_audio_end" });
        }
      }

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
            model: string;
            waitForAudio: () => Promise<{ audioFailed: boolean }>;
          }
      > {
        if (replySystemPrompt === undefined) {
          throw new Error(
            "Unreachable: streamReplyWithPipelinedTTS requires onboarding to have completed",
          );
        }
        const resolvedSystemPrompt = replySystemPrompt;
        // Pass a snapshot: conversationHistory keeps mutating (the assistant reply below, future
        // turns) after this call is made, and callers/tests may hold onto this array.
        const replyStream = getLLMProvider().generateReply(
          [...conversationHistory],
          errors,
          resolvedSystemPrompt,
        );
        const sentenceQueue = new AsyncQueue<{ text: string; highQuality: boolean }>();
        // Resolves «word» emphasis markers (correction-word-emphasis spec) — feeds the plain
        // (marker-stripped) form to captions/persistence/history, and the speech form
        // (marked word upper-cased) to sentence-splitting/TTS below. Upper-casing is a pure case
        // transform, so `sentenceBuffer` (speech form) and `replyText` (plain form) stay
        // character-length-identical throughout, even though only the speech side is actually
        // sentence-split here.
        const markerResolver = createMarkerResolver();
        let sentenceBuffer = "";
        // True once the in-progress sentence has resolved a marker — reset after each sentence is
        // queued. At most one marker per reply (per the system prompt), so there's no ambiguity
        // about which in-progress sentence a resolved marker belongs to.
        let sentenceHasEmphasis = false;
        let replyText = "";
        let audioFailed = false;

        async function consumeAudio(): Promise<void> {
          try {
            for await (const { text, highQuality } of sentenceQueue) {
              if (aborted()) return;
              const { audio, model } = await getTTSProvider({ highQuality }).synthesize(text);
              // Characters are billed by the TTS vendor as soon as the call is made, regardless
              // of whether the resulting stream is fully consumed.
              await recordUsage(sessionId, { ttsCharacters: text.length, ttsModel: model });
              for await (const chunk of audio) {
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

        // Set as soon as a completed sentence trips the output denylist — checked at sentence
        // granularity (the same unit already handed to TTS) rather than per-delta, since a
        // denylisted phrase can span multiple deltas. Sentences queued before the hit have
        // already passed the check and are left to finish playing; the flagged sentence and
        // everything after it is dropped instead of being queued for synthesis. Deltas for the
        // flagged sentence's own text have already been sent to the client as captions by the
        // time its sentence boundary is detected — only the audio side is guarded here.
        let blocked = false;
        try {
          deltaLoop: for await (const delta of replyStream.textStream) {
            if (aborted()) break;
            // Segments (not one aggregated result per delta) so a sentence boundary and a marker
            // landing in the same delta are handled in the order they actually occur — a
            // sentence completed in an earlier segment must not be flagged by a marker resolved
            // in a later one within the same delta.
            for (const segment of markerResolver.feed(delta)) {
              replyText += segment.plain;
              if (segment.plain) send({ type: "reply_text_delta", text: segment.plain });
              if (segment.emphasized) sentenceHasEmphasis = true;
              const { sentences, remainder } = splitSentences(sentenceBuffer + segment.speechText);
              sentenceBuffer = remainder;
              for (const sentence of sentences) {
                if (containsDisallowedContent(sentence)) {
                  blocked = true;
                  break deltaLoop;
                }
                sentenceQueue.push({ text: sentence, highQuality: sentenceHasEmphasis });
                sentenceHasEmphasis = false;
              }
            }
          }
          const flushed = markerResolver.flush();
          replyText += flushed.plain;
          if (flushed.plain) send({ type: "reply_text_delta", text: flushed.plain });
          const finalSentence = (sentenceBuffer + flushed.speechText).trim();
          if (!blocked && finalSentence && !aborted()) {
            if (containsDisallowedContent(finalSentence)) blocked = true;
            else sentenceQueue.push({ text: finalSentence, highQuality: sentenceHasEmphasis });
          }
        } catch (error) {
          request.log.error(error, "Failed to generate reply");
          sentenceQueue.close();
          await audioTask;
          return { textFailed: true };
        }
        sentenceQueue.close();
        if (blocked) {
          request.log.warn("Blocked a generated reply containing disallowed content");
          await audioTask;
          return { textFailed: true };
        }

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
          model: replyStream.model,
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
          if (l1 === undefined) {
            throw new Error("Unreachable: handleTurn requires onboarding to have completed");
          }
          const resolvedL1: L1 = l1;
          if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
            if (!ended) send({ type: "error", message: "Transcript too long" });
            return;
          }
          conversationHistory.push({ role: "user", content: transcript });

          let analysis: AnalysisResult;
          try {
            analysis = await getLLMProvider().analyzeErrors(transcript, resolvedL1);
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
          const { replyText, usage, model: replyModel, waitForAudio } = result;
          pendingAudio = waitForAudio;
          // The vendor calls already ran and were billed regardless of what happens next (abort,
          // persistence failure), so token usage is recorded unconditionally here.
          await recordUsage(sessionId, {
            analysisInputTokens: analysis.usage.inputTokens,
            analysisOutputTokens: analysis.usage.outputTokens,
            analysisModel: analysis.model,
            replyInputTokens: usage.inputTokens,
            replyOutputTokens: usage.outputTokens,
            replyModel,
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

      /**
       * Speaks Kalli's opening line before the learner's first turn, through the same
       * text/audio pipeline a normal reply uses (so barge-in, usage metering, etc. all behave
       * identically) — but it's not a `handleTurn` call: there's no transcript, no error
       * analysis, and it's never persisted as a `turns` row, since it isn't really a turn. Only
       * called once the profile is already complete — an onboarding-mode connection speaks its
       * first onboarding question instead (see `initialOnboardingLine` below).
       */
      async function sendGreeting(): Promise<void> {
        await withActiveTurn((aborted) => speakLine(pickGreeting(completeProfile?.name), aborted));
      }

      /**
       * Handles one user turn while `onboardingFlowState` is non-null: extracts the current
       * field's answer (or a yes/no confirmation, depending on the flow's phase), advances the
       * pure state machine in `onboarding/flow.ts`, and either speaks the next question/confirm
       * line or — once every field is collected — persists the profile, switches the session to
       * coaching mode, and speaks a short transition line. Like `sendGreeting`, none of this is
       * persisted as a `turns` row.
       */
      async function handleOnboardingTurn(transcript: string): Promise<void> {
        if (!onboardingFlowState) return;
        // `userId`'s narrowing to `string` (from the preValidation check far above) doesn't carry
        // into this function — it's a hoisted `function` declaration, not an arrow function
        // defined after the narrowing, so the compiler can't assume it's only ever called
        // afterward. `handleOnboardingTurn` is in fact only ever invoked once that guard has
        // already run, so this is re-establishing a known-true fact, not handling a new case.
        if (!userId) {
          throw new Error("Unreachable: preValidation should have rejected this request");
        }
        await withActiveTurn(async (aborted) => {
          if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
            if (!ended) send({ type: "error", message: "Transcript too long" });
            return;
          }
          const state = onboardingFlowState;
          if (!state) return;

          let result: OnboardingResult;
          try {
            if (state.phase === "asking") {
              const extraction = await extractOnboardingAnswer(state.field, transcript, {
                spelling: state.spelling,
              });
              if (aborted()) return;
              result = submitAnswer(state, extraction);
            } else {
              const { confirmed } = await extractOnboardingConfirmation(transcript);
              if (aborted()) return;
              result = submitConfirmation(state, confirmed);
            }
          } catch (error) {
            request.log.error(error, "Failed to extract onboarding answer");
            if (!ended) send({ type: "error", message: "Could not process your answer" });
            return;
          }

          if (!result.done) {
            onboardingFlowState = result.state;
            await speakLine(result.say, aborted);
            return;
          }

          onboardingFlowState = null;
          const { name, l1: collectedL1, proficiency, context, goals } = result.profile;
          try {
            await db
              .update(profiles)
              .set({ name, l1: collectedL1, proficiency, context, goals })
              .where(eq(profiles.clerkUserId, userId));
          } catch (error) {
            request.log.error(error, "Failed to persist onboarding profile");
            if (!ended) send({ type: "error", message: "Could not save your profile" });
            return;
          }
          l1 = collectedL1;
          replySystemPrompt = buildReplySystemPrompt({ name, proficiency, context, goals });
          send({ type: "profile_updated", name, l1: collectedL1, proficiency, context, goals });
          await speakLine(`Great, ${name} — let's get started!`, aborted);
        });
      }

      try {
        deepgramConnection = await openDeepgramConnection();
      } catch (error) {
        request.log.error(error, "Failed to open Deepgram connection");
        send({ type: "error", message: "Could not start transcription" });
        await endSession("error");
        return;
      }

      /** Shared by both the connection's own `error` event and a `FatalError` protocol message. */
      function handleTranscriptionError(error: Error): void {
        request.log.error(error, "Deepgram connection error");
        send({ type: "error", message: "Transcription error" });
        void endSession("error");
      }

      deepgramConnection.on("message", (data) => {
        if (data.type === "FatalError") {
          handleTranscriptionError(new Error("Deepgram FatalError"));
          return;
        }
        if (data.type !== "TurnInfo") return;

        // StartOfTurn fires once, when Flux itself judges the user has started speaking — unlike
        // Nova-3's raw transcript stream, this is already the model's own confirmed-speech signal,
        // not a bare VAD ping, so no extra "was this really words" check is needed here. Seeding
        // the turn's buffer from the pre-roll window (rather than discarding everything) keeps the
        // stored clip scoped to roughly the turn itself while still covering Flux's own detection
        // latency, instead of clipping the first fraction-second of actual speech.
        if (data.event === "StartOfTurn") {
          turnAudioChunks = [...preRollChunks];
          if (activeTurn || replyPlaying) {
            if (activeTurn) {
              activeTurn.interrupted = true;
              activeTurn = null;
            }
            replyPlaying = false;
            send({ type: "reply_interrupted", reason: "barge_in" });
          }
        }

        // EndOfTurn carries the full assembled transcript for the turn — Flux, not this app,
        // handles combining fragments, so there's no per-turn accumulation to do here.
        if (data.event === "EndOfTurn") {
          if (data.transcript) send({ type: "transcript", text: data.transcript, isFinal: true });
          send({ type: "end_of_turn" });
          const turnAudio =
            !webmHeaderChunk || turnAudioChunks[0] === webmHeaderChunk
              ? Buffer.concat(turnAudioChunks)
              : Buffer.concat([webmHeaderChunk, ...turnAudioChunks]);
          turnAudioChunks = [];
          if (data.transcript) {
            if (onboardingFlowState) void handleOnboardingTurn(data.transcript);
            else void handleTurn(data.transcript, turnAudio);
          }
          return;
        }

        if (data.transcript) send({ type: "transcript", text: data.transcript, isFinal: false });
      });

      deepgramConnection.on("error", handleTranscriptionError);

      deepgramConnection.on("close", () => {
        void endSession("error");
      });

      if (initialOnboardingLine !== null) {
        const onboardingLine = initialOnboardingLine;
        void withActiveTurn((aborted) => speakLine(onboardingLine, aborted));
      } else {
        void sendGreeting();
      }

      handleSocketMessage = (message: Buffer, isBinary: boolean) => {
        if (isBinary) {
          // The client keeps streaming audio chunks until it observes the socket close, which
          // races against Deepgram's own connection closing (network blip, FatalError, quota) and
          // triggering endSession — sendMedia on an already-closed connection throws synchronously
          // inside this event handler, which is otherwise an uncaught exception that crashes the
          // process.
          if (ended) return;
          deepgramConnection.sendMedia(message);
          webmHeaderChunk ??= message;
          turnAudioChunks.push(message);
          preRollChunks.push(message);
          if (preRollChunks.length > PRE_ROLL_CHUNK_COUNT) preRollChunks.shift();
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
      };
      for (const { message, isBinary } of bufferedMessages) handleSocketMessage(message, isBinary);
      bufferedMessages.length = 0;

      socket.on("close", () => {
        void endSession("disconnected");
      });
    },
  );
}
