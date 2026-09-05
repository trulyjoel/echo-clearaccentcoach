import {
  ERROR_CATEGORIES,
  L1_VALUES,
  PROFICIENCY_LEVELS,
  PRONUNCIATION_EDIT_OPS,
  PRONUNCIATION_ERROR_SOURCES,
  SESSION_END_REASONS,
} from "@kalli/types";
import { boolean, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const l1Enum = pgEnum("l1", [...L1_VALUES]);
export const proficiencyEnum = pgEnum("proficiency", [...PROFICIENCY_LEVELS]);

export const profiles = pgTable("profiles", {
  clerkUserId: text("clerk_user_id").primaryKey(),
  name: text("name"),
  l1: l1Enum("l1"),
  proficiency: proficiencyEnum("proficiency"),
  context: text("context"),
  goals: text("goals"),
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

/** The short user-voice segment around a flagged error, stored Opus-compressed on Cloudflare R2. */
export const audioClips = pgTable("audio_clips", {
  id: uuid("id").primaryKey().defaultRandom(),
  storageKey: text("storage_key").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  bookmarked: boolean("bookmarked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const turnErrors = pgTable("turn_errors", {
  id: uuid("id").primaryKey().defaultRandom(),
  turnId: uuid("turn_id")
    .notNull()
    .references(() => turns.id),
  category: errorCategoryEnum("category").notNull(),
  original: text("original").notNull(),
  corrected: text("corrected").notNull(),
  explanation: text("explanation").notNull(),
  audioClipId: uuid("audio_clip_id").references(() => audioClips.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pronunciationEditOpEnum = pgEnum("pronunciation_edit_op", [...PRONUNCIATION_EDIT_OPS]);
export const pronunciationErrorSourceEnum = pgEnum("pronunciation_error_source", [
  ...PRONUNCIATION_ERROR_SOURCES,
]);

export const turnPronunciationErrors = pgTable("turn_pronunciation_errors", {
  id: uuid("id").primaryKey().defaultRandom(),
  turnId: uuid("turn_id")
    .notNull()
    .references(() => turns.id),
  word: text("word").notNull(),
  op: pronunciationEditOpEnum("op").notNull(),
  expectedPhoneme: text("expected_phoneme").notNull(),
  spokenPhoneme: text("spoken_phoneme"),
  source: pronunciationErrorSourceEnum("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-session vendor usage/cost figures, recorded from day one for future billing/limits. */
export const usageRecords = pgTable("usage_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .unique()
    .references(() => sessions.id),
  deepgramSeconds: integer("deepgram_seconds").notNull().default(0),
  deepgramModel: text("deepgram_model"),
  ttsCharacters: integer("tts_characters").notNull().default(0),
  ttsModel: text("tts_model"),
  analysisInputTokens: integer("analysis_input_tokens").notNull().default(0),
  analysisOutputTokens: integer("analysis_output_tokens").notNull().default(0),
  analysisModel: text("analysis_model"),
  replyInputTokens: integer("reply_input_tokens").notNull().default(0),
  replyOutputTokens: integer("reply_output_tokens").notNull().default(0),
  replyModel: text("reply_model"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
