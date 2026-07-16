import cors from "@fastify/cors";
import { clerkPlugin } from "@clerk/fastify";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./routes/auth.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: process.env["WEB_ORIGIN"] ?? "http://localhost:5173" });

  app.get("/health", async () => ({ status: "ok" }));

  app.register(async (apiApp) => {
    apiApp.register(clerkPlugin);
    registerAuthRoutes(apiApp);
  });

  return app;
}
