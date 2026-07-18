import { L1_VALUES, SESSION_END_REASONS } from "@callie/types";
import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { ERROR_CATEGORIES } from "../errorTaxonomy.js";

export const l1Enum = pgEnum("l1", [...L1_VALUES]);

export const profiles = pgTable("profiles", {
  clerkUserId: text("clerk_user_id").primaryKey(),
  l1: l1Enum("l1"),
  consentGivenAt: timestamp("consent_given_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessionEndReasonEnum = pgEnum("session_end_reason", [...SESSION_END_REASONS]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkUserId: text("clerk_user_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endReason: sessionEndReasonEnum("end_reason"),
});

export const turns = pgTable("turns", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id),
  transcript: text("transcript").notNull(),
  reply: text("reply").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const errorCategoryEnum = pgEnum("error_category", [...ERROR_CATEGORIES]);

export const turnErrors = pgTable("turn_errors", {
  id: uuid("id").primaryKey().defaultRandom(),
  turnId: uuid("turn_id")
    .notNull()
    .references(() => turns.id),
  category: errorCategoryEnum("category").notNull(),
  original: text("original").notNull(),
  corrected: text("corrected").notNull(),
  explanation: text("explanation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
