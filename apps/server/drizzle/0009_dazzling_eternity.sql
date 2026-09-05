CREATE TYPE "public"."pronunciation_edit_op" AS ENUM('sub', 'del', 'ins');--> statement-breakpoint
CREATE TABLE "turn_pronunciation_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"word" text NOT NULL,
	"op" "pronunciation_edit_op" NOT NULL,
	"expected_phoneme" text NOT NULL,
	"spoken_phoneme" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "turn_pronunciation_errors" ADD CONSTRAINT "turn_pronunciation_errors_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;