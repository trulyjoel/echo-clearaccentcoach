CREATE TYPE "public"."error_category" AS ENUM('word_order', 'verb_tense_aspect', 'subject_verb_agreement', 'article_usage', 'preposition_choice');--> statement-breakpoint
CREATE TABLE "turn_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"category" "error_category" NOT NULL,
	"original" text NOT NULL,
	"corrected" text NOT NULL,
	"explanation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "turn_errors" ADD CONSTRAINT "turn_errors_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;