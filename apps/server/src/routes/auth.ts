import type { AuthMeResponse } from "@kalli/types";
import type { FastifyInstance } from "fastify";
import { requireUserId } from "../auth.js";

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get("/api/me", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return reply;

    const response: AuthMeResponse = { userId };
    return response;
  });
}
