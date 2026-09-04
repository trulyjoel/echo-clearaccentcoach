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

  it("returns nulls for every field for a first-login user", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/onboarding",
      headers: { authorization: "Bearer test-user-123" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      consentGivenAt: null,
      name: null,
      l1: null,
      proficiency: null,
      context: null,
      goals: null,
    });
  });

  it("returns the full profile once onboarding has set it", async () => {
    const app = buildApp();
    await db.insert(profiles).values({
      clerkUserId: "test-user-123",
      name: "Maria",
      l1: "spanish",
      proficiency: "intermediate",
      context: "work meetings",
      goals: "sounding more natural",
      consentGivenAt: new Date(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/onboarding",
      headers: { authorization: "Bearer test-user-123" },
    });

    const body = response.json() as {
      name: string | null;
      l1: string | null;
      proficiency: string | null;
      context: string | null;
      goals: string | null;
      consentGivenAt: string | null;
    };
    expect(body.name).toBe("Maria");
    expect(body.l1).toBe("spanish");
    expect(body.proficiency).toBe("intermediate");
    expect(body.context).toBe("work meetings");
    expect(body.goals).toBe("sounding more natural");
    expect(body.consentGivenAt).not.toBeNull();
  });
});

describe("POST /api/onboarding", () => {
  it("returns 401 when not authenticated", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding",
      payload: { consent: true },
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns 400 when consent is not explicitly true", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding",
      headers: { authorization: "Bearer test-user-123" },
      payload: { consent: false },
    });

    expect(response.statusCode).toBe(400);
    const [row] = await db.select().from(profiles).where(eq(profiles.clerkUserId, "test-user-123"));
    expect(row).toBeUndefined();
  });

  it("persists a consent timestamp for the authenticated user, leaving other fields null", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding",
      headers: { authorization: "Bearer test-user-123" },
      payload: { consent: true },
    });

    expect(response.statusCode).toBe(200);
    const [row] = await db.select().from(profiles).where(eq(profiles.clerkUserId, "test-user-123"));
    expect(row?.consentGivenAt).not.toBeNull();
    expect(row?.name).toBeNull();
    expect(row?.l1).toBeNull();
  });
});
