import type { ClientToServerMessage, ServerToClientMessage, SessionEndReason } from "@callie/types";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAuthenticatedUserId } from "../auth.js";
import { db } from "../db/client.js";
import { profiles, sessions, turnErrors, turns } from "../db/schema.js";
import type { DeepgramConnection } from "../deepgram.js";
import { openDeepgramConnection } from "../deepgram.js";
import type { DetectedError } from "../errorTaxonomy.js";
import type { ConversationMessage } from "../llm.js";
import { getLLMProvider } from "../llm.js";
import { getTTSProvider } from "../tts.js";

/** Browsers can't set custom headers on a WebSocket handshake, so the client passes the Clerk token as a query param. */
function bridgeQueryToken(request: FastifyRequest): void {
  const { token } = request.query as { token?: string };
  if (token && !request.headers.authorization) {
    request.headers.authorization = `Bearer ${token}`;
  }
}

/** Rejects the WebSocket upgrade (with a normal HTTP status) unless the user is authenticated and consented. */
async function requireConsentedUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  bridgeQueryToken(request);
  const userId = getAuthenticatedUserId(request);
  if (!userId) {
    await reply.code(401).send({ error: "Not authenticated" });
    return;
  }

  const [profile] = await db.select().from(profiles).where(eq(profiles.clerkUserId, userId));
  if (!profile?.l1 || !profile.consentGivenAt) {
    await reply.code(403).send({ error: "Recording consent required" });
  }
}

export function registerSessionRoutes(app: FastifyInstance): void {
  app.get(
    "/api/session",
    { websocket: true, preValidation: requireConsentedUser },
    async (socket, request) => {
      function send(message: ServerToClientMessage): void {
        socket.send(JSON.stringify(message));
      }

      // preValidation already confirmed the user is authenticated and consented.
      const userId = getAuthenticatedUserId(request);
      if (!userId) throw new Error("Unreachable: preValidation should have rejected this request");

      const [session] = await db.insert(sessions).values({ clerkUserId: userId }).returning();
      if (!session) throw new Error("Failed to insert session record");
      const sessionId = session.id;
      send({ type: "session_started", sessionId });

      let deepgramConnection: DeepgramConnection | undefined;
      let ended = false;
      async function endSession(reason: SessionEndReason): Promise<void> {
        if (ended) return;
        ended = true;
        deepgramConnection?.close();
        await db
          .update(sessions)
          .set({ endedAt: new Date(), endReason: reason })
          .where(eq(sessions.id, sessionId));
        send({ type: "session_ended", reason });
        socket.close();
      }

      const conversationHistory: ConversationMessage[] = [];
      let turnTranscriptParts: string[] = [];

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
      async function handleTurn(transcript: string): Promise<void> {
        if (activeTurn) return;
        const myTurn: ActiveTurn = { interrupted: false };
        activeTurn = myTurn;
        const aborted = (): boolean => ended || myTurn.interrupted;
        try {
          conversationHistory.push({ role: "user", content: transcript });

          let errors: DetectedError[];
          try {
            errors = await getLLMProvider().analyzeErrors(transcript);
          } catch (error) {
            request.log.error(error, "Failed to analyze errors");
            if (!ended) send({ type: "error", message: "Could not analyze your speech" });
            return;
          }
          if (aborted()) return;

          let replyText: string;
          try {
            // Pass a snapshot: conversationHistory keeps mutating (the assistant reply below,
            // future turns) after this call is made, and callers/tests may hold onto this array.
            replyText = await getLLMProvider().generateReply([...conversationHistory], errors);
          } catch (error) {
            request.log.error(error, "Failed to generate reply");
            if (!ended) send({ type: "error", message: "Could not generate a reply" });
            return;
          }
          if (aborted()) return;
          conversationHistory.push({ role: "assistant", content: replyText });

          try {
            await db.transaction(async (tx) => {
              const [turn] = await tx
                .insert(turns)
                .values({ sessionId, transcript, reply: replyText })
                .returning();
              if (!turn) throw new Error("Failed to insert turn record");
              if (errors.length > 0) {
                await tx
                  .insert(turnErrors)
                  .values(errors.map((error) => ({ turnId: turn.id, ...error })));
              }
            });
          } catch (error) {
            request.log.error(error, "Failed to persist turn");
            if (!ended) send({ type: "error", message: "Could not save this turn" });
            return;
          }
          if (aborted()) return;
          send({ type: "reply_text", text: replyText });

          try {
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

      deepgramConnection.on("message", (data) => {
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

        if (data.speech_final) {
          send({ type: "end_of_turn" });
          const turnTranscript = turnTranscriptParts.join(" ").trim();
          turnTranscriptParts = [];
          if (turnTranscript) void handleTurn(turnTranscript);
        }
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
