import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("GET /health", () => {
  it("returns 200 with a status ok payload", async () => {
    const app = buildApp();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("GET /api/session", () => {
  it("rejects an unauthenticated request with 401, not a 500 from Clerk not being ready yet", async () => {
    // Uses the real clerkPlugin (unlike routes/session.test.ts, which mocks it away) so this
    // catches bugs in *when* the plugin's auth hook runs relative to route-level auth checks.
    //
    // A plain (non-upgrade) request is used rather than `injectWS`: Fastify runs the same
    // hook pipeline for both (the websocket plugin dispatches upgrades through the normal
    // router), and `injectWS` hardcodes `sec-websocket-version` as a number, which crashes
    // Clerk's header parsing — a bug in the simulated handshake, not in real traffic, where
    // that header always arrives as a string.
    const app = buildApp();
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/session" });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});
