import type { ClientToServerMessage, ServerToClientMessage, SessionEndReason } from "@callie/types";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAuthenticatedUserId } from "../auth.js";
import { db } from "../db/client.js";
import { profiles, sessions } from "../db/schema.js";
import type { DeepgramConnection } from "../deepgram.js";
import { openDeepgramConnection } from "../deepgram.js";

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

        send({ type: "transcript", text: transcript, isFinal: data.is_final ?? false });
        if (data.speech_final) {
          send({ type: "end_of_turn" });
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
      });

      socket.on("close", () => {
        void endSession("disconnected");
      });
    },
  );
}
