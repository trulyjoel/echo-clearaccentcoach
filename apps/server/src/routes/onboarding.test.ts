import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { db } from "../db/client.js";
import { profiles } from "../db/schema.js";

vi.mock("@clerk/fastify", () => ({
  clerkPlugin: async () => {},
  getAuth: (request: { headers: { authorization?: string } }) => {
    if (request.headers.authorization === "Bearer test-user-123") {
      return { isAuthenticated: true, userId: "test-user-123" };
    }
    return { isAuthenticated: false, userId: null };
  },
}));

afterEach(async () => {
  await db.delete(profiles);
});

describe("GET /api/onboarding", () => {
  it("returns 401 when not authenticated", async () => {
    const app = buildApp();

    const response = await app.inject({ method: "GET", url: "/api/onboarding" });

    expect(response.statusCode).toBe(401);
  });

  it("returns null l1 and consentGivenAt for a first-login user", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/onboarding",
      headers: { authorization: "Bearer test-user-123" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ l1: null, consentGivenAt: null });
  });

  it("returns the persisted l1 and consent timestamp for a returning user", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: "/api/onboarding",
      headers: { authorization: "Bearer test-user-123" },
      payload: { l1: "spanish", consent: true },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/onboarding",
      headers: { authorization: "Bearer test-user-123" },
    });

    const body = response.json() as { l1: string | null; consentGivenAt: string | null };
    expect(body.l1).toBe("spanish");
    expect(body.consentGivenAt).not.toBeNull();
  });
});

describe("POST /api/onboarding", () => {
  it("returns 401 when not authenticated", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding",
      payload: { l1: "spanish", consent: true },
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns 400 for an unsupported l1 value", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding",
      headers: { authorization: "Bearer test-user-123" },
      payload: { l1: "klingon", consent: true },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 when consent is not explicitly true", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding",
      headers: { authorization: "Bearer test-user-123" },
      payload: { l1: "spanish", consent: false },
    });

    expect(response.statusCode).toBe(400);
    const [row] = await db.select().from(profiles).where(eq(profiles.clerkUserId, "test-user-123"));
    expect(row).toBeUndefined();
  });

  it("persists l1 and a consent timestamp for the authenticated user", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding",
      headers: { authorization: "Bearer test-user-123" },
      payload: { l1: "other", consent: true },
    });

    expect(response.statusCode).toBe(200);
    const [row] = await db.select().from(profiles).where(eq(profiles.clerkUserId, "test-user-123"));
    expect(row?.l1).toBe("other");
    expect(row?.consentGivenAt).not.toBeNull();
  });
});
