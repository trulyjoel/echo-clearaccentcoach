import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { clerkPlugin } from "@clerk/fastify";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerErrorRoutes } from "./routes/errors.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerSessionRoutes } from "./routes/session.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: process.env["WEB_ORIGIN"] ?? "http://localhost:5173" });
  app.register(websocket);

  app.get("/health", async () => ({ status: "ok" }));

  app.register(async (apiApp) => {
    // onRequest so this runs before any route's own auth hook, including preValidation hooks
    // like the session route's (preValidation fires before Fastify's default preHandler hook).
    apiApp.register(clerkPlugin, { hookName: "onRequest" });
    registerAuthRoutes(apiApp);
    registerOnboardingRoutes(apiApp);
    registerSessionRoutes(apiApp);
    registerErrorRoutes(apiApp);
  });

  return app;
}
