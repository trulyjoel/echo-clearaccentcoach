import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { clerkPlugin } from "@clerk/fastify";
import Fastify, { type FastifyInstance } from "fastify";
import { bridgeQueryToken } from "./auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerErrorRoutes } from "./routes/errors.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerSessionRoutes } from "./routes/session.js";

/**
 * Parses a comma-separated WEB_ORIGIN value into exact origins and regexes.
 *
 * An entry wrapped in slashes (e.g. `/^https:\/\/foo-.*\.vercel\.app$/`) is treated as a
 * regex, which lets staging allow Vercel's per-deploy preview origins without hardcoding
 * one URL that goes stale on every deploy.
 */
export function parseWebOrigins(value: string): (string | RegExp)[] {
  return value.split(",").map((entry) => {
    const trimmed = entry.trim();
    const regexMatch = /^\/(.*)\/$/.exec(trimmed);
    return regexMatch ? new RegExp(regexMatch[1]!) : trimmed;
  });
}

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: parseWebOrigins(process.env["WEB_ORIGIN"] ?? "http://localhost:5173") });
  app.register(websocket);

  app.get("/health", async () => ({ status: "ok" }));

  app.register(async (apiApp) => {
    // Must run before clerkPlugin's own onRequest hook, which computes and caches Clerk's auth
    // result from whatever headers are present at that point (see bridgeQueryToken's docstring).
    apiApp.addHook("onRequest", bridgeQueryToken);
    apiApp.register(clerkPlugin, { hookName: "onRequest" });
    registerAuthRoutes(apiApp);
    registerOnboardingRoutes(apiApp);
    registerSessionRoutes(apiApp);
    registerErrorRoutes(apiApp);
    registerHistoryRoutes(apiApp);
  });

  return app;
}
