import type { AuthMeResponse } from "@callie/types";
import { getAuth } from "@clerk/fastify";
import type { FastifyInstance } from "fastify";

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get("/api/me", async (request, reply) => {
    const { isAuthenticated, userId } = getAuth(request);

    if (!isAuthenticated || !userId) {
      return reply.status(401).send({ error: "Not authenticated" });
    }

    const response: AuthMeResponse = { userId };
    return response;
  });
}
