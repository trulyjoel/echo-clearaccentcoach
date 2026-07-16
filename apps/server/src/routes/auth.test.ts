import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";

vi.mock("@clerk/fastify", () => ({
  clerkPlugin: async () => {},
  getAuth: (request: { headers: { authorization?: string } }) => {
    if (request.headers.authorization === "Bearer test-user-123") {
      return { isAuthenticated: true, userId: "test-user-123" };
    }
    return { isAuthenticated: false, userId: null };
  },
}));

describe("GET /api/me", () => {
  it("returns 401 when the request is not authenticated", async () => {
    const app = buildApp();

    const response = await app.inject({ method: "GET", url: "/api/me" });

    expect(response.statusCode).toBe(401);
  });

  it("returns the authenticated user's id when authenticated", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer test-user-123" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: "test-user-123" });
  });
});
