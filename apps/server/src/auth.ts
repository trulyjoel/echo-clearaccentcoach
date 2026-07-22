import { getAuth } from "@clerk/fastify";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Browsers can't set custom headers on a WebSocket handshake, so the client passes the Clerk
 * token as a query param instead — this copies it into the header Clerk's own auth hook expects.
 *
 * Registered globally as an `onRequest` hook, and must run *before* `clerkPlugin`'s: Clerk
 * computes and caches its auth result once, in its own `onRequest` hook, from whatever headers
 * are present at that point — a later hook (e.g. a route's `preValidation`) setting the header
 * would be too late to affect that already-cached result.
 */
export async function bridgeQueryToken(request: FastifyRequest): Promise<void> {
  const { token } = request.query as { token?: string };
  if (token && !request.headers.authorization) {
    request.headers.authorization = `Bearer ${token}`;
  }
}

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
