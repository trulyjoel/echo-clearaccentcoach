import type { OnboardingRequest, OnboardingStatusResponse } from "@kalli/types";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireUserId } from "../auth.js";
import { db } from "../db/client.js";
import { profiles } from "../db/schema.js";

export function registerOnboardingRoutes(app: FastifyInstance): void {
  app.get("/api/onboarding", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return reply;

    const [profile] = await db.select().from(profiles).where(eq(profiles.clerkUserId, userId));

    const response: OnboardingStatusResponse = {
      consentGivenAt: profile?.consentGivenAt?.toISOString() ?? null,
      name: profile?.name ?? null,
      l1: profile?.l1 ?? null,
      proficiency: profile?.proficiency ?? null,
      context: profile?.context ?? null,
      goals: profile?.goals ?? null,
    };
    return response;
  });

  app.post("/api/onboarding", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return reply;

    const body = request.body as Partial<OnboardingRequest> | undefined;

    if (body?.consent !== true) {
      return reply.status(400).send({ error: "consent must be explicitly given" });
    }

    const consentGivenAt = new Date();

    await db
      .insert(profiles)
      .values({ clerkUserId: userId, consentGivenAt })
      .onConflictDoUpdate({
        target: profiles.clerkUserId,
        set: { consentGivenAt },
      });

    const response: OnboardingStatusResponse = {
      consentGivenAt: consentGivenAt.toISOString(),
      name: null,
      l1: null,
      proficiency: null,
      context: null,
      goals: null,
    };
    return response;
  });
}
