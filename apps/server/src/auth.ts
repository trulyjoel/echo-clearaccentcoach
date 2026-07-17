import { getAuth } from "@clerk/fastify";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Sends a 401 and returns undefined when the request isn't authenticated. */
export function requireUserId(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const { isAuthenticated, userId } = getAuth(request);

  if (!isAuthenticated || !userId) {
    reply.status(401).send({ error: "Not authenticated" });
    return undefined;
  }

  return userId;
}
