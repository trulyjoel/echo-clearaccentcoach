CREATE TYPE "public"."l1" AS ENUM('spanish', 'mandarin', 'vietnamese', 'korean', 'arabic', 'other');--> statement-breakpoint
CREATE TABLE "profiles" (
	"clerk_user_id" text PRIMARY KEY NOT NULL,
	"l1" "l1",
	"consent_given_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
