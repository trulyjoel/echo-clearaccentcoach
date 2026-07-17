import type { L1, OnboardingRequest, OnboardingStatusResponse } from "@callie/types";
import { L1_VALUES } from "@callie/types";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireUserId } from "../auth.js";
import { db } from "../db/client.js";
import { profiles } from "../db/schema.js";

function isL1(value: unknown): value is L1 {
  return typeof value === "string" && (L1_VALUES as readonly string[]).includes(value);
}

export function registerOnboardingRoutes(app: FastifyInstance): void {
  app.get("/api/onboarding", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return reply;

    const [profile] = await db.select().from(profiles).where(eq(profiles.clerkUserId, userId));

    const response: OnboardingStatusResponse = {
      l1: profile?.l1 ?? null,
      consentGivenAt: profile?.consentGivenAt?.toISOString() ?? null,
    };
    return response;
  });

  app.post("/api/onboarding", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return reply;

    const body = request.body as Partial<OnboardingRequest> | undefined;

    if (!isL1(body?.l1)) {
      return reply.status(400).send({ error: "l1 must be one of the supported languages" });
    }

    if (body?.consent !== true) {
      return reply.status(400).send({ error: "consent must be explicitly given" });
    }

    const consentGivenAt = new Date();

    await db
      .insert(profiles)
      .values({ clerkUserId: userId, l1: body.l1, consentGivenAt })
      .onConflictDoUpdate({
        target: profiles.clerkUserId,
        set: { l1: body.l1, consentGivenAt },
      });

    const response: OnboardingStatusResponse = {
      l1: body.l1,
      consentGivenAt: consentGivenAt.toISOString(),
    };
    return response;
  });
}
