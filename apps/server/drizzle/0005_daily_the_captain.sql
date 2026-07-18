CREATE TABLE "audio_clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"bookmarked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "turn_errors" ADD COLUMN "audio_clip_id" uuid;--> statement-breakpoint
ALTER TABLE "turn_errors" ADD CONSTRAINT "turn_errors_audio_clip_id_audio_clips_id_fk" FOREIGN KEY ("audio_clip_id") REFERENCES "public"."audio_clips"("id") ON DELETE set null ON UPDATE no action;