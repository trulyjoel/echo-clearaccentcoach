CREATE TYPE "public"."proficiency" AS ENUM('beginner', 'intermediate', 'advanced');--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "proficiency" "proficiency";--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "goals" text;