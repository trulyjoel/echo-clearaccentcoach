import { L1_VALUES } from "@callie/types";
import { pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const l1Enum = pgEnum("l1", [...L1_VALUES]);

export const profiles = pgTable("profiles", {
  clerkUserId: text("clerk_user_id").primaryKey(),
  l1: l1Enum("l1"),
  consentGivenAt: timestamp("consent_given_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
