# Kokoro TTS Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kokoro (served via DeepInfra) the default TTS backend for Kalli's spoken replies,
~65-75x cheaper than ElevenLabs, while keeping ElevenLabs available behind a manual environment
toggle for instant rollback — plus a checked-in script to compare both vendors' audio quality
(and several candidate Kokoro voices) before shipping.

**Architecture:** `apps/server/src/tts.ts`'s existing `TTSProvider` interface gains a second
implementation (`KokoroTTSProvider`, a thin `fetch` client against DeepInfra's Kokoro endpoint) and
a `TTS_PROVIDER` env var toggle in `getTTSProvider()`. The interface changes shape so each provider
reports its own `model` alongside the audio stream (mirroring `LLMProvider` in `llm.ts`), so
`session.ts`'s usage logging no longer hardcodes a vendor. Usage/cost DB columns are renamed to be
vendor-neutral (`ttsCharacters`/`ttsModel`) since either provider now writes to them.

**Tech Stack:** Node 22, Fastify, Drizzle ORM (Postgres), Vitest, plain `fetch` (no new SDK for
DeepInfra).

**Spec:** `docs/superpowers/specs/2026-08-25-kokoro-tts-swap-design.md`

## Global Constraints

- `TTS_PROVIDER` env var: `"kokoro"` (default, unset also means Kokoro) or `"elevenlabs"`. No other
  values are handled specially.
- `output_format=mp3` is fixed, not configurable — required to match the browser's hardcoded
  `audio/mpeg` `MediaSource` buffer (`apps/web/src/Session.tsx:235`). No `apps/web` changes.
- No self-hosted Kokoro — DeepInfra's hosted endpoint only.
- No automatic runtime fallback between providers — `TTS_PROVIDER` is a manual, deploy-time switch.
- `@elevenlabs/elevenlabs-js` dependency stays in `package.json` — ElevenLabs remains fully wired.
- No new SDK dependency for DeepInfra — a plain `fetch` call, since DeepInfra has no JS SDK and the
  request is a single streaming `POST`.
- The usage-column rename must use `RENAME COLUMN` in a hand-written migration, not a drizzle-kit
  drop+add diff — preserves historical per-session cost data.

---

### Task 1: Rename TTS usage/cost tracking columns to be vendor-neutral

**Files:**
- Modify: `apps/server/src/db/schema.ts:66-67`
- Modify: `apps/server/src/usage.ts` (whole file)
- Modify: `apps/server/src/routes/session.ts` (the `recordUsage` call inside `consumeAudio`, around
  line 256 — field names only, not yet the `getTTSProvider()` call shape)
- Modify: `apps/server/src/routes/session.test.ts` (usage-metering assertions, ~lines 1202, 1232-1241,
  1273)
- Create: `apps/server/drizzle/0007_rename_tts_usage_columns.sql`
- Create: `apps/server/drizzle/meta/0007_snapshot.json`
- Modify: `apps/server/drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `UsageDelta.ttsCharacters: number`, `UsageDelta.ttsModel: string` (replacing
  `elevenlabsCharacters`/`elevenlabsModel`); DB columns `usage_records.tts_characters`,
  `usage_records.tts_model`.

- [ ] **Step 1: Update the usage-metering test to expect the new field names (write the failing test)**

In `apps/server/src/routes/session.test.ts`, change the test title and assertions:

```ts
  it("records LLM token usage and TTS characters synthesized for a turn", async () => {
```

(was `"records LLM token usage and ElevenLabs characters synthesized for a turn"`)

```ts
    expect(usage).toMatchObject({
      analysisInputTokens: 20,
      analysisOutputTokens: 4,
      analysisModel: llmTestState.analysisModel,
      replyInputTokens: 30,
      replyOutputTokens: 12,
      replyModel: llmTestState.replyModel,
      ttsCharacters: "Nice job!".length,
      ttsModel: "eleven_flash_v2_5",
    });
```

And a few lines below, in the "accumulates usage across multiple turns" test:

```ts
    expect(usage?.ttsCharacters).toBe(2 * "Nice job!".length);
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @kalli/server test -- src/routes/session.test.ts`
Expected: FAIL — `usage.ttsCharacters` / `usage.ttsModel` are `undefined` (the columns are still
named `elevenlabs_characters`/`elevenlabs_model` in the DB and schema).

- [ ] **Step 3: Rename the columns in the schema**

In `apps/server/src/db/schema.ts`, replace lines 66-67:

```ts
  ttsCharacters: integer("tts_characters").notNull().default(0),
  ttsModel: text("tts_model"),
```

- [ ] **Step 4: Rename the fields in `usage.ts`**

Replace the full contents of `apps/server/src/usage.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { usageRecords } from "./db/schema.js";

export interface UsageDelta {
  deepgramSeconds: number;
  deepgramModel: string;
  ttsCharacters: number;
  ttsModel: string;
  analysisInputTokens: number;
  analysisOutputTokens: number;
  analysisModel: string;
  replyInputTokens: number;
  replyOutputTokens: number;
  replyModel: string;
}

const ZERO_COUNTS = {
  deepgramSeconds: 0,
  ttsCharacters: 0,
  analysisInputTokens: 0,
  analysisOutputTokens: 0,
  replyInputTokens: 0,
  replyOutputTokens: 0,
};

/** Creates the zeroed usage row a session's turns/duration will accumulate into. */
export async function ensureUsageRecord(sessionId: string): Promise<void> {
  await db.insert(usageRecords).values({ sessionId });
}

/**
 * Adds `delta`'s counts onto the session's running usage totals and, for model-name fields,
 * overwrites with whatever value `delta` provides. Count fields omitted from `delta` default to
 * 0, so this doubles as a "set once" call for fields (like `deepgramSeconds`) only ever reported
 * a single time per session. Model fields are omitted from the update entirely when absent from
 * `delta`, rather than overwritten with a default, since a vendor call always reports its own
 * model alongside its usage and there's nothing to zero them to.
 */
export async function recordUsage(sessionId: string, delta: Partial<UsageDelta>): Promise<void> {
  const counts = { ...ZERO_COUNTS, ...delta };
  await db
    .update(usageRecords)
    .set({
      deepgramSeconds: sql`${usageRecords.deepgramSeconds} + ${counts.deepgramSeconds}`,
      ttsCharacters: sql`${usageRecords.ttsCharacters} + ${counts.ttsCharacters}`,
      analysisInputTokens: sql`${usageRecords.analysisInputTokens} + ${counts.analysisInputTokens}`,
      analysisOutputTokens: sql`${usageRecords.analysisOutputTokens} + ${counts.analysisOutputTokens}`,
      replyInputTokens: sql`${usageRecords.replyInputTokens} + ${counts.replyInputTokens}`,
      replyOutputTokens: sql`${usageRecords.replyOutputTokens} + ${counts.replyOutputTokens}`,
      updatedAt: new Date(),
      ...(delta.deepgramModel !== undefined && { deepgramModel: delta.deepgramModel }),
      ...(delta.ttsModel !== undefined && { ttsModel: delta.ttsModel }),
      ...(delta.analysisModel !== undefined && { analysisModel: delta.analysisModel }),
      ...(delta.replyModel !== undefined && { replyModel: delta.replyModel }),
    })
    .where(eq(usageRecords.sessionId, sessionId));
}
```

- [ ] **Step 5: Rename the `recordUsage` call site in `session.ts`**

In `apps/server/src/routes/session.ts`, inside `consumeAudio` (do not touch the `ELEVENLABS_MODEL`
import or the `getTTSProvider().synthesize()` call yet — that's Task 2):

```ts
              // Characters are billed by ElevenLabs as soon as the call is made, regardless of
              // whether the resulting stream is fully consumed.
              await recordUsage(sessionId, {
                ttsCharacters: sentence.length,
                ttsModel: ELEVENLABS_MODEL,
              });
```

(only the two keys inside the object change: `elevenlabsCharacters` → `ttsCharacters`,
`elevenlabsModel` → `ttsModel`)

- [ ] **Step 6: Write the migration files by hand**

Create `apps/server/drizzle/0007_rename_tts_usage_columns.sql`:

```sql
ALTER TABLE "usage_records" RENAME COLUMN "elevenlabs_characters" TO "tts_characters";--> statement-breakpoint
ALTER TABLE "usage_records" RENAME COLUMN "elevenlabs_model" TO "tts_model";
```

Create `apps/server/drizzle/meta/0007_snapshot.json` — identical to
`apps/server/drizzle/meta/0006_snapshot.json` except `id`, `prevId` (set to 0006's `id`), and the
two renamed columns under `tables["public.usage_records"].columns`:

```json
{
  "id": "a4d8f2c1-3e7b-4c9a-8f1d-6b2e9c5a7d3f",
  "prevId": "2be7c514-f576-49b3-8e47-861ad3dddbf8",
  "version": "7",
  "dialect": "postgresql",
  "tables": {
    "public.audio_clips": {
      "name": "audio_clips",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "uuid",
          "primaryKey": true,
          "notNull": true,
          "default": "gen_random_uuid()"
        },
        "storage_key": { "name": "storage_key", "type": "text", "primaryKey": false, "notNull": true },
        "expires_at": {
          "name": "expires_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true
        },
        "bookmarked": {
          "name": "bookmarked",
          "type": "boolean",
          "primaryKey": false,
          "notNull": true,
          "default": false
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {},
      "foreignKeys": {},
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.profiles": {
      "name": "profiles",
      "schema": "",
      "columns": {
        "clerk_user_id": { "name": "clerk_user_id", "type": "text", "primaryKey": true, "notNull": true },
        "l1": { "name": "l1", "type": "l1", "typeSchema": "public", "primaryKey": false, "notNull": false },
        "consent_given_at": {
          "name": "consent_given_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": false
        },
        "created_at": {
          "name": "created_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {},
      "foreignKeys": {},
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.sessions": {
      "name": "sessions",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "uuid",
          "primaryKey": true,
          "notNull": true,
          "default": "gen_random_uuid()"
        },
        "clerk_user_id": { "name": "clerk_user_id", "type": "text", "primaryKey": false, "notNull": true },
        "started_at": {
          "name": "started_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        },
        "ended_at": {
          "name": "ended_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": false
        },
        "end_reason": {
          "name": "end_reason",
          "type": "session_end_reason",
          "typeSchema": "public",
          "primaryKey": false,
          "notNull": false
        }
      },
      "indexes": {},
      "foreignKeys": {},
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.turn_errors": {
      "name": "turn_errors",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "uuid",
          "primaryKey": true,
          "notNull": true,
          "default": "gen_random_uuid()"
        },
        "turn_id": { "name": "turn_id", "type": "uuid", "primaryKey": false, "notNull": true },
        "category": {
          "name": "category",
          "type": "error_category",
          "typeSchema": "public",
          "primaryKey": false,
          "notNull": true
        },
        "original": { "name": "original", "type": "text", "primaryKey": false, "notNull": true },
        "corrected": { "name": "corrected", "type": "text", "primaryKey": false, "notNull": true },
        "explanation": { "name": "explanation", "type": "text", "primaryKey": false, "notNull": true },
        "audio_clip_id": { "name": "audio_clip_id", "type": "uuid", "primaryKey": false, "notNull": false },
        "created_at": {
          "name": "created_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {},
      "foreignKeys": {
        "turn_errors_turn_id_turns_id_fk": {
          "name": "turn_errors_turn_id_turns_id_fk",
          "tableFrom": "turn_errors",
          "tableTo": "turns",
          "columnsFrom": ["turn_id"],
          "columnsTo": ["id"],
          "onDelete": "no action",
          "onUpdate": "no action"
        },
        "turn_errors_audio_clip_id_audio_clips_id_fk": {
          "name": "turn_errors_audio_clip_id_audio_clips_id_fk",
          "tableFrom": "turn_errors",
          "tableTo": "audio_clips",
          "columnsFrom": ["audio_clip_id"],
          "columnsTo": ["id"],
          "onDelete": "set null",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.turns": {
      "name": "turns",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "uuid",
          "primaryKey": true,
          "notNull": true,
          "default": "gen_random_uuid()"
        },
        "session_id": { "name": "session_id", "type": "uuid", "primaryKey": false, "notNull": true },
        "transcript": { "name": "transcript", "type": "text", "primaryKey": false, "notNull": true },
        "reply": { "name": "reply", "type": "text", "primaryKey": false, "notNull": true },
        "created_at": {
          "name": "created_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {},
      "foreignKeys": {
        "turns_session_id_sessions_id_fk": {
          "name": "turns_session_id_sessions_id_fk",
          "tableFrom": "turns",
          "tableTo": "sessions",
          "columnsFrom": ["session_id"],
          "columnsTo": ["id"],
          "onDelete": "no action",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {},
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    },
    "public.usage_records": {
      "name": "usage_records",
      "schema": "",
      "columns": {
        "id": {
          "name": "id",
          "type": "uuid",
          "primaryKey": true,
          "notNull": true,
          "default": "gen_random_uuid()"
        },
        "session_id": { "name": "session_id", "type": "uuid", "primaryKey": false, "notNull": true },
        "deepgram_seconds": {
          "name": "deepgram_seconds",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "deepgram_model": { "name": "deepgram_model", "type": "text", "primaryKey": false, "notNull": false },
        "tts_characters": {
          "name": "tts_characters",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "tts_model": { "name": "tts_model", "type": "text", "primaryKey": false, "notNull": false },
        "analysis_input_tokens": {
          "name": "analysis_input_tokens",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "analysis_output_tokens": {
          "name": "analysis_output_tokens",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "analysis_model": { "name": "analysis_model", "type": "text", "primaryKey": false, "notNull": false },
        "reply_input_tokens": {
          "name": "reply_input_tokens",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "reply_output_tokens": {
          "name": "reply_output_tokens",
          "type": "integer",
          "primaryKey": false,
          "notNull": true,
          "default": 0
        },
        "reply_model": { "name": "reply_model", "type": "text", "primaryKey": false, "notNull": false },
        "updated_at": {
          "name": "updated_at",
          "type": "timestamp with time zone",
          "primaryKey": false,
          "notNull": true,
          "default": "now()"
        }
      },
      "indexes": {},
      "foreignKeys": {
        "usage_records_session_id_sessions_id_fk": {
          "name": "usage_records_session_id_sessions_id_fk",
          "tableFrom": "usage_records",
          "tableTo": "sessions",
          "columnsFrom": ["session_id"],
          "columnsTo": ["id"],
          "onDelete": "no action",
          "onUpdate": "no action"
        }
      },
      "compositePrimaryKeys": {},
      "uniqueConstraints": {
        "usage_records_session_id_unique": {
          "name": "usage_records_session_id_unique",
          "nullsNotDistinct": false,
          "columns": ["session_id"]
        }
      },
      "policies": {},
      "checkConstraints": {},
      "isRLSEnabled": false
    }
  },
  "enums": {
    "public.error_category": {
      "name": "error_category",
      "schema": "public",
      "values": [
        "word_order",
        "verb_tense_aspect",
        "subject_verb_agreement",
        "article_usage",
        "preposition_choice"
      ]
    },
    "public.l1": {
      "name": "l1",
      "schema": "public",
      "values": ["spanish", "mandarin", "vietnamese", "korean", "arabic", "other"]
    },
    "public.session_end_reason": {
      "name": "session_end_reason",
      "schema": "public",
      "values": ["user_ended", "disconnected", "error", "max_duration"]
    }
  },
  "schemas": {},
  "sequences": {},
  "roles": {},
  "policies": {},
  "views": {},
  "_meta": { "columns": {}, "schemas": {}, "tables": {} }
}
```

Append to `apps/server/drizzle/meta/_journal.json`'s `"entries"` array:

```json
    {
      "idx": 7,
      "version": "7",
      "when": 1787000000000,
      "tag": "0007_rename_tts_usage_columns",
      "breakpoints": true
    }
```

- [ ] **Step 7: Apply the migration to the test database**

Run:
```bash
cd apps/server
set -a; source .env.test; set +a
pnpm db:migrate
```
Expected: drizzle-kit reports applying `0007_rename_tts_usage_columns`.

- [ ] **Step 8: Run the test and confirm it passes**

Run: `pnpm --filter @kalli/server test -- src/routes/session.test.ts`
Expected: PASS, including the "usage metering" suite.

- [ ] **Step 9: Typecheck**

Run: `pnpm --filter @kalli/server typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/usage.ts apps/server/src/routes/session.ts \
  apps/server/src/routes/session.test.ts apps/server/drizzle/0007_rename_tts_usage_columns.sql \
  apps/server/drizzle/meta/0007_snapshot.json apps/server/drizzle/meta/_journal.json
git commit -m "Rename TTS usage/cost tracking columns to be vendor-neutral"
```

Also apply the migration to your local dev database so `pnpm dev` keeps working:
```bash
cd apps/server
set -a; source .env; set +a
pnpm db:migrate
```

---

### Task 2: Change `TTSProvider` to report its own model, per-call

**Files:**
- Modify: `apps/server/src/tts.ts` (`TTSProvider` interface, `ElevenLabsTTSProvider`)
- Modify: `apps/server/src/tts.test.ts`
- Modify: `apps/server/src/routes/session.ts` (imports + `consumeAudio`)
- Modify: `apps/server/src/routes/session.test.ts` (`ttsTestState` mock + its two
  `setSynthesizeImpl` call sites)

**Interfaces:**
- Consumes: `UsageDelta.ttsCharacters`/`ttsModel` (Task 1).
- Produces: `TTSProvider.synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }>`.

- [ ] **Step 1: Update the ElevenLabs test to assert the new return shape (write the failing test)**

Replace the `ElevenLabsTTSProvider.synthesize` describe block in `apps/server/src/tts.test.ts`:

```ts
describe("ElevenLabsTTSProvider.synthesize", () => {
  afterEach(() => {
    elevenLabsTestState.streamCalls.length = 0;
  });

  it("sends sanitized text to ElevenLabs, not the raw quoted text", async () => {
    process.env["ELEVENLABS_API_KEY"] = "test-key";
    const provider = getTTSProvider();

    const { model } = await provider.synthesize('Small thing — "I saw a movie."');

    expect(elevenLabsTestState.streamCalls.at(-1)?.text).toBe("Small thing — I saw a movie.");
    expect(model).toBe("eleven_flash_v2_5");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @kalli/server test -- src/tts.test.ts`
Expected: FAIL — `synthesize()` currently returns a bare `AsyncIterable`, so `model` is `undefined`.

- [ ] **Step 3: Change the `TTSProvider` interface**

In `apps/server/src/tts.ts`, replace the interface:

```ts
export interface TTSProvider {
  /** Synthesizes `text` to speech, streamed as audio chunks as they're produced, alongside the
   * model that produced it (each provider reports its own — see `llm.ts`'s `LLMProvider` for the
   * same pattern). */
  synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }>;
}
```

- [ ] **Step 4: Update `ElevenLabsTTSProvider` to match**

Replace the class body:

```ts
class ElevenLabsTTSProvider implements TTSProvider {
  async synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
    const audio = await getClient().textToSpeech.stream(getVoiceId(), {
      text: sanitizeForSpeech(text),
      modelId: ELEVENLABS_MODEL,
      outputFormat: "mp3_44100_128",
    });
    return { audio, model: ELEVENLABS_MODEL };
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm --filter @kalli/server test -- src/tts.test.ts`
Expected: PASS.

- [ ] **Step 6: Update `session.ts` to use the new return shape**

In `apps/server/src/routes/session.ts`, change the import (drop `ELEVENLABS_MODEL`, it's no longer
needed here):

```ts
import { getTTSProvider } from "../tts.js";
```

And inside `consumeAudio`, replace:

```ts
              // Characters are billed by ElevenLabs as soon as the call is made, regardless of
              // whether the resulting stream is fully consumed.
              await recordUsage(sessionId, {
                ttsCharacters: sentence.length,
                ttsModel: ELEVENLABS_MODEL,
              });
              const audioChunks = await getTTSProvider().synthesize(sentence);
              for await (const chunk of audioChunks) {
                if (aborted()) return;
                socket.send(Buffer.from(chunk));
              }
```

with:

```ts
              const { audio, model } = await getTTSProvider().synthesize(sentence);
              // Characters are billed by the TTS vendor as soon as the call is made, regardless
              // of whether the resulting stream is fully consumed.
              await recordUsage(sessionId, { ttsCharacters: sentence.length, ttsModel: model });
              for await (const chunk of audio) {
                if (aborted()) return;
                socket.send(Buffer.from(chunk));
              }
```

- [ ] **Step 7: Update the `ttsTestState` mock in `session.test.ts`**

Replace the `ttsTestState` block and its `vi.mock("../tts.js", ...)`:

```ts
const ttsTestState = vi.hoisted(() => {
  async function* defaultChunks(): AsyncIterable<Uint8Array> {
    yield new Uint8Array([1, 2, 3]);
    yield new Uint8Array([4, 5]);
  }

  const MOCK_TTS_MODEL = "mock-tts-model";
  type SynthesizeResult = { audio: AsyncIterable<Uint8Array>; model: string };
  let synthesizeImpl: (text: string) => Promise<SynthesizeResult> = async () => ({
    audio: defaultChunks(),
    model: MOCK_TTS_MODEL,
  });
  const calls: string[] = [];

  return {
    model: MOCK_TTS_MODEL,
    reset: (): void => {
      synthesizeImpl = async () => ({ audio: defaultChunks(), model: MOCK_TTS_MODEL });
      calls.length = 0;
    },
    setSynthesizeImpl: (fn: (text: string) => Promise<SynthesizeResult>): void => {
      synthesizeImpl = fn;
    },
    getCalls: (): string[] => calls,
    getTTSProvider: vi.fn(() => ({
      synthesize: async (text: string) => {
        calls.push(text);
        return synthesizeImpl(text);
      },
    })),
  };
});

vi.mock("../tts.js", () => ({
  getTTSProvider: ttsTestState.getTTSProvider,
}));
```

- [ ] **Step 8: Update the two `pausableChunks` call sites**

In both places in `apps/server/src/routes/session.test.ts` (around lines 1453 and 1498) that read:

```ts
    ttsTestState.setSynthesizeImpl(async () => pausableChunks());
```

change to:

```ts
    ttsTestState.setSynthesizeImpl(async () => ({ audio: pausableChunks(), model: ttsTestState.model }));
```

- [ ] **Step 9: Update the usage-metering assertions to expect the mock's model**

In the "records LLM token usage and TTS characters synthesized for a turn" test, change:

```ts
      ttsModel: ttsTestState.model,
```

(replacing the literal `"eleven_flash_v2_5"` from Task 1 — the mock no longer claims to be
ElevenLabs specifically)

- [ ] **Step 10: Run the full session test file and confirm it passes**

Run: `pnpm --filter @kalli/server test -- src/routes/session.test.ts`
Expected: PASS.

- [ ] **Step 11: Typecheck**

Run: `pnpm --filter @kalli/server typecheck`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add apps/server/src/tts.ts apps/server/src/tts.test.ts apps/server/src/routes/session.ts \
  apps/server/src/routes/session.test.ts
git commit -m "Make TTSProvider report its own model per call"
```

---

### Task 3: Add `KokoroTTSProvider` and the `TTS_PROVIDER` toggle

**Files:**
- Modify: `apps/server/src/tts.ts` (whole file)
- Modify: `apps/server/src/tts.test.ts` (whole file)
- Modify: `apps/server/.env.example`

**Interfaces:**
- Consumes: `TTSProvider` interface (Task 2).
- Produces: `KOKORO_MODEL: string`, `synthesizeKokoro(text: string, voiceId: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }>`, `getTTSProvider()` now branches on `process.env["TTS_PROVIDER"]`.

- [ ] **Step 1: Add failing tests for `synthesizeKokoro` and the provider toggle**

Replace the full contents of `apps/server/src/tts.test.ts`:

```ts
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const elevenLabsTestState = vi.hoisted(() => ({
  streamCalls: [] as { voiceId: string; text: string }[],
}));
vi.mock("@elevenlabs/elevenlabs-js", () => ({
  ElevenLabsClient: class {
    textToSpeech = {
      stream: vi.fn(async (voiceId: string, options: { text: string }) => {
        elevenLabsTestState.streamCalls.push({ voiceId, text: options.text });
        return (async function* () {})();
      }),
    };
  },
}));

const { getTTSProvider, sanitizeForSpeech, synthesizeKokoro } = await import("./tts.js");

/** Wraps bytes as a fetch `Response` whose `.body` streams them — mirrors the shape DeepInfra's
 * real streaming endpoint returns. */
function fetchResponseFromChunks(chunks: Uint8Array[], status = 200): Response {
  async function* body(): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) yield chunk;
  }
  const webStream = Readable.toWeb(Readable.from(body())) as unknown as ReadableStream<Uint8Array>;
  return new Response(webStream, { status });
}

describe("sanitizeForSpeech", () => {
  it("strips straight double quotes", () => {
    expect(sanitizeForSpeech('Small thing — "I saw a movie."')).toBe(
      "Small thing — I saw a movie.",
    );
  });

  it("strips curly/typographic double quotes", () => {
    expect(sanitizeForSpeech("Small thing — “I saw a movie.”")).toBe(
      "Small thing — I saw a movie.",
    );
  });

  it("preserves apostrophes in contractions", () => {
    expect(sanitizeForSpeech("you'd say I've been living here")).toBe(
      "you'd say I've been living here",
    );
  });

  it("preserves em dashes", () => {
    expect(sanitizeForSpeech("bare Make needs something — after it")).toBe(
      "bare Make needs something — after it",
    );
  });

  it("strips multiple quoted segments in one sentence", () => {
    const input = 'Ha, gotta say "Make it fast" or "speed things up" — bare "Make" needs it!';
    expect(sanitizeForSpeech(input)).toBe(
      "Ha, gotta say Make it fast or speed things up — bare Make needs it!",
    );
  });
});

describe("ElevenLabsTTSProvider.synthesize", () => {
  afterEach(() => {
    elevenLabsTestState.streamCalls.length = 0;
    delete process.env["TTS_PROVIDER"];
    delete process.env["ELEVENLABS_API_KEY"];
  });

  it("sends sanitized text to ElevenLabs, not the raw quoted text", async () => {
    process.env["TTS_PROVIDER"] = "elevenlabs";
    process.env["ELEVENLABS_API_KEY"] = "test-key";

    const { model } = await getTTSProvider().synthesize('Small thing — "I saw a movie."');

    expect(elevenLabsTestState.streamCalls.at(-1)?.text).toBe("Small thing — I saw a movie.");
    expect(model).toBe("eleven_flash_v2_5");
  });
});

describe("synthesizeKokoro", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env["DEEPINFRA_API_KEY"];
  });

  it("posts sanitized text to DeepInfra's stream endpoint for the given voice", async () => {
    process.env["DEEPINFRA_API_KEY"] = "test-deepinfra-key";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return fetchResponseFromChunks([new Uint8Array([9, 9])]);
    }) as unknown as typeof fetch;

    const { audio, model } = await synthesizeKokoro('Nice — "great job."', "af_bella");
    const chunks: Uint8Array[] = [];
    for await (const chunk of audio) chunks.push(chunk as Uint8Array);

    expect(capturedUrl).toBe(
      "https://api.deepinfra.com/v1/text-to-speech/af_bella/stream?output_format=mp3",
    );
    expect(capturedInit?.headers).toMatchObject({ "xi-api-key": "test-deepinfra-key" });
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      text: "Nice — great job.",
      model_id: "hexgrad/Kokoro-82M",
    });
    expect(model).toBe("hexgrad/Kokoro-82M");
    expect(chunks).toEqual([new Uint8Array([9, 9])]);
  });

  it("throws when DEEPINFRA_API_KEY is unset", async () => {
    await expect(synthesizeKokoro("hi", "af_heart")).rejects.toThrow("DEEPINFRA_API_KEY");
  });
});

describe("getTTSProvider", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    elevenLabsTestState.streamCalls.length = 0;
    delete process.env["TTS_PROVIDER"];
    delete process.env["DEEPINFRA_API_KEY"];
    delete process.env["ELEVENLABS_API_KEY"];
  });

  it("defaults to Kokoro when TTS_PROVIDER is unset", async () => {
    process.env["DEEPINFRA_API_KEY"] = "test-key";
    global.fetch = vi.fn(async () => fetchResponseFromChunks([])) as unknown as typeof fetch;

    await getTTSProvider().synthesize("hi");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(elevenLabsTestState.streamCalls).toEqual([]);
  });

  it("uses ElevenLabs when TTS_PROVIDER=elevenlabs", async () => {
    process.env["TTS_PROVIDER"] = "elevenlabs";
    process.env["ELEVENLABS_API_KEY"] = "test-key";

    await getTTSProvider().synthesize("hi");

    expect(elevenLabsTestState.streamCalls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test and confirm the new tests fail**

Run: `pnpm --filter @kalli/server test -- src/tts.test.ts`
Expected: FAIL — `synthesizeKokoro` doesn't exist yet, and `getTTSProvider` ignores `TTS_PROVIDER`.

- [ ] **Step 3: Implement Kokoro support in `tts.ts`**

Replace the full contents of `apps/server/src/tts.ts`:

```ts
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

/** ElevenLabs' "Rachel" premade voice — an existing preset voice, per the ticket's scope. */
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
/** A clear American-English female Kokoro voice — the closest preset analog to "Rachel." */
const DEFAULT_KOKORO_VOICE_ID = "af_heart";

export const ELEVENLABS_MODEL = "eleven_flash_v2_5";
export const KOKORO_MODEL = "hexgrad/Kokoro-82M";

export interface TTSProvider {
  /** Synthesizes `text` to speech, streamed as audio chunks as they're produced, alongside the
   * model that produced it (each provider reports its own — see `llm.ts`'s `LLMProvider` for the
   * same pattern). */
  synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }>;
}

/**
 * Strips double-quote characters before text reaches the TTS model. Quoted phrases (common when
 * Kalli repeats back a corrected phrase) came out of `eleven_flash_v2_5` sounding like
 * mispronounced punctuation rather than prosody; applied to every provider by default, pending a
 * listening check on whether Kokoro needs the same treatment. Apostrophes are left untouched since
 * they're load-bearing for contractions ("I'll", "you'd").
 */
export function sanitizeForSpeech(text: string): string {
  return text.replace(/["“”]/g, "");
}

function getApiKey(): string {
  const apiKey = process.env["ELEVENLABS_API_KEY"];
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is required (see apps/server/.env.example)");
  }
  return apiKey;
}

function getVoiceId(): string {
  return process.env["ELEVENLABS_VOICE_ID"] ?? DEFAULT_VOICE_ID;
}

let client: ElevenLabsClient | undefined;

function getClient(): ElevenLabsClient {
  client ??= new ElevenLabsClient({ apiKey: getApiKey() });
  return client;
}

class ElevenLabsTTSProvider implements TTSProvider {
  async synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
    const audio = await getClient().textToSpeech.stream(getVoiceId(), {
      text: sanitizeForSpeech(text),
      modelId: ELEVENLABS_MODEL,
      outputFormat: "mp3_44100_128",
    });
    return { audio, model: ELEVENLABS_MODEL };
  }
}

function getDeepInfraApiKey(): string {
  const apiKey = process.env["DEEPINFRA_API_KEY"];
  if (!apiKey) {
    throw new Error("DEEPINFRA_API_KEY is required (see apps/server/.env.example)");
  }
  return apiKey;
}

/** Calls DeepInfra's Kokoro endpoint for a specific voice — factored out so the voice-comparison
 * script (`src/scripts/compareTts.ts`) can request multiple candidate voices without duplicating
 * the request shape. */
export async function synthesizeKokoro(
  text: string,
  voiceId: string,
): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
  const response = await fetch(
    `https://api.deepinfra.com/v1/text-to-speech/${voiceId}/stream?output_format=mp3`,
    {
      method: "POST",
      headers: {
        "xi-api-key": getDeepInfraApiKey(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: sanitizeForSpeech(text), model_id: KOKORO_MODEL }),
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`DeepInfra TTS request failed: ${response.status} ${await response.text()}`);
  }
  const audio = Readable.fromWeb(response.body as NodeWebReadableStream<Uint8Array>);
  return { audio, model: KOKORO_MODEL };
}

class KokoroTTSProvider implements TTSProvider {
  synthesize(text: string): Promise<{ audio: AsyncIterable<Uint8Array>; model: string }> {
    return synthesizeKokoro(text, process.env["DEEPINFRA_VOICE_ID"] ?? DEFAULT_KOKORO_VOICE_ID);
  }
}

/**
 * Picks the provider fresh on every call based on `TTS_PROVIDER` (no memoized singleton — each
 * provider class is stateless, the one expensive lazy object is `client` above, which is already
 * cached independently) so the env var can be flipped per-call, which is also what makes it
 * straightforward to exercise both branches in tests.
 */
export function getTTSProvider(): TTSProvider {
  return process.env["TTS_PROVIDER"] === "elevenlabs"
    ? new ElevenLabsTTSProvider()
    : new KokoroTTSProvider();
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm --filter @kalli/server test -- src/tts.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `.env.example`**

In `apps/server/.env.example`, replace the ElevenLabs block:

```
# TTS provider: "kokoro" (default, via DeepInfra) or "elevenlabs". Manual rollback switch — flip
# to "elevenlabs" if Kokoro quality/reliability is a problem in production.
TTS_PROVIDER=

# DeepInfra (https://deepinfra.com) — hosts the Kokoro-82M open-weight TTS model used by default
# to synthesize Kalli's spoken replies. Required unless TTS_PROVIDER=elevenlabs.
DEEPINFRA_API_KEY=
# Kokoro voice ID to use for Kalli. Optional — defaults to "af_heart". See
# apps/server/src/scripts/compareTts.ts to compare candidate voices.
DEEPINFRA_VOICE_ID=

# ElevenLabs (https://elevenlabs.io) — only read when TTS_PROVIDER=elevenlabs.
ELEVENLABS_API_KEY=
# Voice ID to use for Kalli. Optional — defaults to the "Rachel" premade voice.
ELEVENLABS_VOICE_ID=
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @kalli/server typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/tts.ts apps/server/src/tts.test.ts apps/server/.env.example
git commit -m "Add KokoroTTSProvider and the TTS_PROVIDER toggle"
```

---

### Task 4: Voice comparison script

**Files:**
- Create: `apps/server/src/scripts/ttsComparisonWriter.ts`
- Create: `apps/server/src/scripts/ttsComparisonWriter.test.ts`
- Create: `apps/server/src/scripts/compareTts.ts`
- Modify: `apps/server/src/tts.ts` (export `ElevenLabsTTSProvider`)
- Modify: `apps/server/package.json` (add `compare-tts` script)
- Modify: `.gitignore` (repo root)

**Interfaces:**
- Consumes: `synthesizeKokoro`, `ElevenLabsTTSProvider` (now exported), `KOKORO_MODEL` (Task 3).
- Produces: `writeAudioToFile(audio: AsyncIterable<Uint8Array>, filePath: string): Promise<void>`.

- [ ] **Step 1: Write the failing test for the file-writing helper**

Create `apps/server/src/scripts/ttsComparisonWriter.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAudioToFile } from "./ttsComparisonWriter.js";

describe("writeAudioToFile", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("concatenates streamed chunks into a single file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tts-comparison-test-"));
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5]);
    }
    const filePath = path.join(dir, "out.mp3");

    await writeAudioToFile(chunks(), filePath);

    expect(await readFile(filePath)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @kalli/server test -- src/scripts/ttsComparisonWriter.test.ts`
Expected: FAIL — `./ttsComparisonWriter.js` doesn't exist yet.

- [ ] **Step 3: Implement the helper**

Create `apps/server/src/scripts/ttsComparisonWriter.ts`:

```ts
import { writeFile } from "node:fs/promises";

/** Drains a streamed audio source and writes it to `filePath` as a single file, for local
 * listening comparisons. */
export async function writeAudioToFile(
  audio: AsyncIterable<Uint8Array>,
  filePath: string,
): Promise<void> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of audio) chunks.push(chunk);
  await writeFile(filePath, Buffer.concat(chunks));
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm --filter @kalli/server test -- src/scripts/ttsComparisonWriter.test.ts`
Expected: PASS.

- [ ] **Step 5: Export `ElevenLabsTTSProvider`**

In `apps/server/src/tts.ts`, change:

```ts
class ElevenLabsTTSProvider implements TTSProvider {
```

to:

```ts
export class ElevenLabsTTSProvider implements TTSProvider {
```

- [ ] **Step 6: Implement the comparison script**

Create `apps/server/src/scripts/compareTts.ts`:

```ts
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ElevenLabsTTSProvider, synthesizeKokoro } from "../tts.js";
import { writeAudioToFile } from "./ttsComparisonWriter.js";

/** A representative Kalli reply: warm tone, a corrected-phrase quote (exercises
 * `sanitizeForSpeech`), and a contraction (exercises the apostrophe-preserving path). */
const KALLI_TEST_PHRASE =
  "That's a great try! Quick correction though — instead of saying " +
  '"I have went to the store," you\'d say "I went to the store." ' +
  "Want to practice that one more time?";

const KOKORO_VOICE_CANDIDATES = ["af_heart", "af_bella", "af_nicole", "af_sky"];

async function main(): Promise<void> {
  const outputDir = path.join(import.meta.dirname, "..", "..", "tts-comparison");
  await mkdir(outputDir, { recursive: true });

  const elevenLabs = await new ElevenLabsTTSProvider().synthesize(KALLI_TEST_PHRASE);
  await writeAudioToFile(elevenLabs.audio, path.join(outputDir, "elevenlabs.mp3"));
  console.log(`Wrote elevenlabs.mp3 (${elevenLabs.model})`);

  for (const voiceId of KOKORO_VOICE_CANDIDATES) {
    const { audio, model } = await synthesizeKokoro(KALLI_TEST_PHRASE, voiceId);
    await writeAudioToFile(audio, path.join(outputDir, `kokoro-${voiceId}.mp3`));
    console.log(`Wrote kokoro-${voiceId}.mp3 (${model})`);
  }

  console.log(`\nAll candidates written to ${outputDir}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 7: Add the `compare-tts` package.json script**

In `apps/server/package.json`, add to `"scripts"` (alongside `"dev"`):

```json
    "compare-tts": "tsx --env-file=.env src/scripts/compareTts.ts",
```

- [ ] **Step 8: Gitignore the comparison output directory**

In the repo root `.gitignore`, add:

```
apps/server/tts-comparison/
```

- [ ] **Step 9: Typecheck**

Run: `pnpm --filter @kalli/server typecheck`
Expected: no errors.

- [ ] **Step 10: Run the full server test suite**

Run: `pnpm --filter @kalli/server test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/server/src/scripts/ttsComparisonWriter.ts apps/server/src/scripts/ttsComparisonWriter.test.ts \
  apps/server/src/scripts/compareTts.ts apps/server/src/tts.ts apps/server/package.json .gitignore
git commit -m "Add TTS voice comparison script"
```

- [ ] **Step 12 (manual, not part of the automated suite): run the comparison and pick a voice**

With `DEEPINFRA_API_KEY` and `ELEVENLABS_API_KEY` set in `apps/server/.env`:

```bash
pnpm --filter @kalli/server compare-tts
```

Listen to the files written to `apps/server/tts-comparison/`. Set `DEEPINFRA_VOICE_ID` in your
deploy environment to whichever candidate sounds closest to the current voice. If Kokoro's overall
quality isn't acceptable, set `TTS_PROVIDER=elevenlabs` instead — no code change needed.
