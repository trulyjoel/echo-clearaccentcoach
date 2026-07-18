ALTER TYPE "public"."session_end_reason" ADD VALUE 'max_duration';--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"deepgram_seconds" integer DEFAULT 0 NOT NULL,
	"elevenlabs_characters" integer DEFAULT 0 NOT NULL,
	"analysis_input_tokens" integer DEFAULT 0 NOT NULL,
	"analysis_output_tokens" integer DEFAULT 0 NOT NULL,
	"reply_input_tokens" integer DEFAULT 0 NOT NULL,
	"reply_output_tokens" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;