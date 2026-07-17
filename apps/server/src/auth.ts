import { getAuth } from "@clerk/fastify";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Returns the authenticated user's id, or undefined if the request isn't authenticated. */
export function getAuthenticatedUserId(request: FastifyRequest): string | undefined {
  const { isAuthenticated, userId } = getAuth(request);
  return isAuthenticated && userId ? userId : undefined;
}

/** Sends a 401 and returns undefined when the request isn't authenticated. */
export function requireUserId(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const userId = getAuthenticatedUserId(request);

  if (!userId) {
    reply.status(401).send({ error: "Not authenticated" });
    return undefined;
  }

  return userId;
}
