import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { clerkPlugin } from "@clerk/fastify";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerSessionRoutes } from "./routes/session.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: process.env["WEB_ORIGIN"] ?? "http://localhost:5173" });
  app.register(websocket);

  app.get("/health", async () => ({ status: "ok" }));

  app.register(async (apiApp) => {
    apiApp.register(clerkPlugin);
    registerAuthRoutes(apiApp);
    registerOnboardingRoutes(apiApp);
    registerSessionRoutes(apiApp);
  });

  return app;
}
