# Pronunciation error detection (server-side pipeline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, independent analysis pass to Kalli's turn pipeline that detects phoneme-level
mispronunciations (via an HTTP call to a pronunciation-scoring service) and surfaces them through
the exact same live-conversation flow grammar corrections already use — spoken correction woven
into Kalli's reply, full breakdown persisted and sent to the client.

**Architecture:** `handleTurn` in `apps/server/src/routes/session.ts` gains a second concurrent
branch alongside the existing `analyzeErrors` grammar call: G2P the turn's transcript into canonical
ARPAbet phones, POST the turn's audio + those phones to a `PronunciationProvider` (a new vendor
adapter matching the existing `deepgram.ts`/`llm.ts`/`tts.ts` shape), and get back a list of
per-word edit operations. Both analysis calls run via `Promise.all` and both feed pass 2
(`generateReply`), which picks the single most relevant correction across either pool.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM/Postgres, Vitest, the `phonemize` npm package for
grapheme-to-phoneme conversion, `fetch`/`FormData`/`Blob` (Node built-ins) for the HTTP call to the
pronunciation-scoring service.

**Spec:** `docs/superpowers/specs/2026-09-04-pronunciation-correction-design.md`

**Scope note:** the spec's `apps/pronunciation-service/` (the Python/Modal-hosted HuPER
Recognizer+Corrector service) is explicitly a separate subsystem — different language, different
deploy target, tested by its own convention "when that app is built" (spec, Testing section). This
plan covers only the TypeScript/server side: it implements `PronunciationProvider` as a real HTTP
client against a documented request/response contract (defined in Task 4 below) and tests it
against a fake, the same way `deepgram.ts`/`llm.ts`/`tts.ts` are already tested. Building the actual
Modal service to satisfy that contract is a separate follow-on plan.

## Global Constraints

- ESM only, Node 22 LTS runtime (existing `apps/server` convention).
- Follow this codebase's existing relative-import style (`./foo.js` / `../foo.js`, explicit `.js`
  extensions) — an established codebase pattern that overrides the generic absolute-imports-only
  default for this repo.
- Exact dependency versions only (no `^`/`~`), matching every existing entry in
  `apps/server/package.json`.
- ≤100 lines/function, cyclomatic complexity ≤8, 100-char line length.
- Mock only external vendor/HTTP boundaries in tests (the pattern every existing adapter in this
  repo already follows — Deepgram, the LLM provider, TTS); everything else (orchestration,
  persistence, WS delivery) runs for real against the real test Postgres database.
- Every new/changed export needs Google-style docstrings where the existing codebase already uses
  them (it's inconsistent — match the density of comments in the file being edited).

---

## Task 1: G2P module

**Files:**
- Create: `apps/server/src/g2p.ts`
- Test: `apps/server/src/g2p.test.ts`
- Modify: `apps/server/package.json` (add `phonemize` dependency)

**Interfaces:**
- Produces: `CanonicalWord { word: string; phones: string[] }`, `g2p(transcript: string):
  CanonicalWord[]` — both consumed by Task 4 (`pronunciation.ts`) and Task 6 (`session.ts`).

`phonemize` (npm, MIT, pure JS, zero native deps, verified current version `1.2.0`) does both
CMUdict-style dictionary lookup (125,000+ words) and rule-based G2P fallback for out-of-dictionary
words in one call, and can emit ARPABET directly — no second fallback library needed. Its ARPABET
output includes lexical-stress digits (e.g. `OW1`); HuPER's phone set is stress-free bare ARPAbet
(confirmed against the HuPER quickstart's own example: `"AY R OW T AH L EH T ER"`, no digits), so
`stripStress: true` is required to match HuPER's phone convention.

- [ ] **Step 1: Add the `phonemize` dependency**

Edit `apps/server/package.json`, adding to `dependencies` (keep alphabetical, matching the existing
list):

```json
"phonemize": "1.2.0",
```

Run `pnpm install` from the repo root.

- [ ] **Step 2: Write the failing tests**

```ts
// apps/server/src/g2p.test.ts
import { describe, expect, it } from "vitest";
import { g2p } from "./g2p.js";

describe("g2p", () => {
  it("produces word-aligned ARPAbet phones with no stress digits for a dictionary word", () => {
    const result = g2p("cat");

    expect(result).toEqual([{ word: "cat", phones: expect.arrayContaining(["K", "AE", "T"]) }]);
    for (const { phones } of result) {
      for (const phone of phones) expect(phone).not.toMatch(/[0-9]/);
    }
  });

  it("produces one CanonicalWord per word, in transcript order, for a multi-word transcript", () => {
    const result = g2p("I like cats");

    expect(result.map((w) => w.word)).toEqual(["I", "like", "cats"]);
    for (const { phones } of result) expect(phones.length).toBeGreaterThan(0);
  });

  it("falls back to rule-based G2P for a word not in the dictionary, without throwing", () => {
    const result = g2p("zxqzptrl");

    expect(result).toHaveLength(1);
    expect(result[0]?.word).toBe("zxqzptrl");
    expect(result[0]?.phones.length).toBeGreaterThan(0);
  });

  it("strips punctuation before phonemizing so it isn't treated as a word", () => {
    const result = g2p("Hello, world!");

    expect(result.map((w) => w.word)).toEqual(["Hello", "world"]);
  });

  it("returns an empty array for an empty or whitespace-only transcript", () => {
    expect(g2p("")).toEqual([]);
    expect(g2p("   ")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @kalli/server test -- g2p.test.ts`
Expected: FAIL with "Cannot find module './g2p.js'" (the module doesn't exist yet).

- [ ] **Step 4: Implement `g2p.ts`**

```ts
// apps/server/src/g2p.ts
import { phonemize } from "phonemize";

/** One transcript word and its canonical (target-accent) ARPAbet phones, stress-digit-free to
 * match HuPER's phone convention. */
export interface CanonicalWord {
  word: string;
  phones: string[];
}

/** Matches runs of word characters and apostrophes (so contractions like "don't" stay one word),
 * discarding surrounding punctuation — `phonemize` would otherwise treat punctuation as its own
 * token. */
const WORD_PATTERN = /[\p{L}\p{N}']+/gu;

/**
 * G2P's the turn's transcript into a word-aligned canonical ARPAbet phone sequence, used as the
 * "expected" reference the pronunciation-scoring service diffs the actual audio against.
 * Dictionary words come from `phonemize`'s bundled CMUdict-derived lexicon; out-of-dictionary
 * words (names, coinages) fall through to its rule-based G2P automatically — both paths return
 * through the same call, so this function doesn't need to know which one fired.
 */
export function g2p(transcript: string): CanonicalWord[] {
  const words = transcript.match(WORD_PATTERN) ?? [];
  return words.map((word) => ({
    word,
    phones: phonemize(word, {
      language: "en-US",
      format: "arpabet",
      stripStress: true,
      returnArray: true,
    }) as string[],
  }));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @kalli/server test -- g2p.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm --filter @kalli/server typecheck && pnpm --filter @kalli/server exec oxlint src/g2p.ts src/g2p.test.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/g2p.ts apps/server/src/g2p.test.ts
git commit -m "Add G2P module for canonical phone lookup"
```

---

## Task 2: Shared pronunciation-error types

**Files:**
- Modify: `packages/types/src/index.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PRONUNCIATION_EDIT_OPS`, `PronunciationEditOpKind`, `DetectedPronunciationError`,
  `PersistedPronunciationError`, and the `turn_pronunciation_errors` variant of
  `ServerToClientMessage` — consumed by Task 3 (schema enum), Task 4 (`pronunciation.ts`), Task 5
  (`llm.ts`), and Task 6 (`session.ts`).

This mirrors `ERROR_CATEGORIES`/`DetectedError`/`PersistedError` in the same file — a parallel,
not-merged shape, since the fields genuinely differ (phoneme/edit-op vs.
category/original/corrected/explanation), the same reasoning that already keeps the grammar
taxonomy separate.

- [ ] **Step 1: Add the types**

Add this block to `packages/types/src/index.ts`, directly after the existing `PersistedError`
interface:

```ts
/** The three kinds of deviation a phoneme-level pronunciation diff can find, relative to the
 * canonical (target-accent) phone at a given position. */
export const PRONUNCIATION_EDIT_OPS = ["sub", "del", "ins"] as const;

export type PronunciationEditOpKind = (typeof PRONUNCIATION_EDIT_OPS)[number];

/** One detected pronunciation deviation for a single word in a turn — e.g. a substituted phoneme
 * (an L2 /l/-for-/r/ swap), a dropped phoneme, or an inserted one. */
export interface DetectedPronunciationError {
  word: string;
  op: PronunciationEditOpKind;
  expectedPhoneme: string;
  /** The phoneme actually realized in the audio, or `null` for a deletion (nothing was spoken in
   * its place). */
  spokenPhoneme: string | null;
}

/** A `DetectedPronunciationError` once persisted, addressable for the correction panel. */
export interface PersistedPronunciationError extends DetectedPronunciationError {
  id: string;
}
```

- [ ] **Step 2: Extend `ServerToClientMessage`**

In the same file, add a new variant to the `ServerToClientMessage` union, directly after the
existing `turn_errors` variant:

```ts
  | {
      type: "turn_pronunciation_errors";
      turnId: string;
      createdAt: string;
      errors: PersistedPronunciationError[];
    }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @kalli/types exec tsc --noEmit`
Expected: no errors. (No behavior to unit-test here — this file is type/const declarations only;
correctness is verified by every downstream task's own tests compiling and passing against these
shapes.)

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/index.ts
git commit -m "Add shared pronunciation-error types"
```

---

## Task 3: Database schema and migration

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: a new drizzle migration file under `apps/server/drizzle/` (auto-named by `db:generate`)
- Test: `apps/server/src/db/schema.test.ts` (new file — no existing schema-level test file to
  extend; the rest of this repo's DB-touching tests live in `session.test.ts` against the full
  pipeline, but a schema-only round-trip test is worth having in isolation since this task has no
  other consumer yet)

**Interfaces:**
- Consumes: `PRONUNCIATION_EDIT_OPS` from Task 2 (`@kalli/types`).
- Produces: `pronunciationEditOpEnum`, `turnPronunciationErrors` (Drizzle table) — consumed by
  Task 6 (`session.ts`'s `persistTurn`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/db/schema.test.ts
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "./client.js";
import { sessions, turnPronunciationErrors, turns } from "./schema.js";

describe("turnPronunciationErrors", () => {
  it("round-trips a row linked to a turn", async () => {
    const [session] = await db.insert(sessions).values({ clerkUserId: "test-user-schema" }).returning();
    if (!session) throw new Error("Failed to insert session");
    const [turn] = await db
      .insert(turns)
      .values({ sessionId: session.id, transcript: "he rike it", reply: "You'd say 'like' there." })
      .returning();
    if (!turn) throw new Error("Failed to insert turn");

    const [error] = await db
      .insert(turnPronunciationErrors)
      .values({
        turnId: turn.id,
        word: "like",
        op: "sub",
        expectedPhoneme: "L",
        spokenPhoneme: "R",
      })
      .returning();

    expect(error).toMatchObject({
      turnId: turn.id,
      word: "like",
      op: "sub",
      expectedPhoneme: "L",
      spokenPhoneme: "R",
    });

    const fetched = await db
      .select()
      .from(turnPronunciationErrors)
      .where(eq(turnPronunciationErrors.turnId, turn.id));
    expect(fetched).toHaveLength(1);
  });

  it("allows a null spokenPhoneme for a deletion", async () => {
    const [session] = await db.insert(sessions).values({ clerkUserId: "test-user-schema-2" }).returning();
    if (!session) throw new Error("Failed to insert session");
    const [turn] = await db
      .insert(turns)
      .values({ sessionId: session.id, transcript: "I as a doctor", reply: "..." })
      .returning();
    if (!turn) throw new Error("Failed to insert turn");

    const [error] = await db
      .insert(turnPronunciationErrors)
      .values({ turnId: turn.id, word: "as", op: "del", expectedPhoneme: "Z", spokenPhoneme: null })
      .returning();

    expect(error?.spokenPhoneme).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kalli/server test -- db/schema.test.ts`
Expected: FAIL — `turnPronunciationErrors` is not exported from `./schema.js`.

- [ ] **Step 3: Add the schema**

In `apps/server/src/db/schema.ts`, add the import and the new enum + table, directly after the
existing `turnErrors` table definition:

```ts
import { PRONUNCIATION_EDIT_OPS } from "@kalli/types"; // add to the existing @kalli/types import line
```

```ts
export const pronunciationEditOpEnum = pgEnum("pronunciation_edit_op", [...PRONUNCIATION_EDIT_OPS]);

export const turnPronunciationErrors = pgTable("turn_pronunciation_errors", {
  id: uuid("id").primaryKey().defaultRandom(),
  turnId: uuid("turn_id")
    .notNull()
    .references(() => turns.id),
  word: text("word").notNull(),
  op: pronunciationEditOpEnum("op").notNull(),
  expectedPhoneme: text("expected_phoneme").notNull(),
  spokenPhoneme: text("spoken_phoneme"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Generate and apply the migration**

Run: `pnpm --filter @kalli/server db:generate`

This produces a new file under `apps/server/drizzle/` (auto-named by drizzle-kit). Review it — it
should contain a `CREATE TYPE pronunciation_edit_op AS ENUM (...)` and a
`CREATE TABLE turn_pronunciation_errors (...)` statement, nothing else.

Apply it to both local databases:

```bash
pnpm --filter @kalli/server db:migrate  # applies to kalli_dev per DATABASE_URL
DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @kalli/server db:migrate  # applies to kalli_test
```

(Match whatever env-var convention the existing `.env`/`.env.test` files in `apps/server/` already
use for pointing at `kalli_dev` vs `kalli_test` — check `apps/server/vitest.config.ts` and
`apps/server/.env.example` for the exact variable name before running the second command.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @kalli/server test -- db/schema.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm --filter @kalli/server typecheck && pnpm --filter @kalli/server exec oxlint src/db/schema.ts src/db/schema.test.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/schema.test.ts apps/server/drizzle/
git commit -m "Add turn_pronunciation_errors table"
```

---

## Task 4: Pronunciation-scoring vendor adapter

**Files:**
- Create: `apps/server/src/pronunciation.ts`
- Test: `apps/server/src/pronunciation.test.ts`
- Modify: `apps/server/.env.example` (document the new env var)

**Interfaces:**
- Consumes: `CanonicalWord` from Task 1 (`./g2p.js`), `PronunciationEditOpKind` from Task 2
  (`@kalli/types`).
- Produces: `PronunciationEditOp { word: string; wordIndex: number; op: PronunciationEditOpKind;
  expectedPhoneme: string; spokenPhoneme: string | null }`, `PronunciationProvider { scoreTurn(audio:
  Buffer, canonicalPhones: CanonicalWord[]): Promise<PronunciationEditOp[]> }`,
  `getPronunciationProvider(): PronunciationProvider` — consumed by Task 6 (`session.ts`).

**HTTP contract with the (separately built) pronunciation service:**
`POST {PRONUNCIATION_SERVICE_URL}/score`, `multipart/form-data` body: an `audio` file part
(`audio/webm`, the turn's raw WebM/Opus bytes, unmodified — decoding happens service-side per the
spec) and a `canonical_phones` text part (the `CanonicalWord[]` array, JSON-stringified). Response:
`200` with JSON body `{ "editOps": PronunciationEditOp[] }`, or a non-2xx status with a text error
body on failure. This mirrors the request/response shape `InworldTTSProvider` in `tts.ts` already
uses for its own HTTP vendor call (`fetch` + explicit status check + typed JSON parse), just with a
multipart request instead of a JSON one, since this call sends binary audio rather than receiving
it.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/src/pronunciation.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalWord } from "./g2p.js";
import { getPronunciationProvider } from "./pronunciation.js";

const SAMPLE_PHONES: CanonicalWord[] = [{ word: "like", phones: ["L", "AY", "K"] }];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("HttpPronunciationProvider", () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env["PRONUNCIATION_SERVICE_URL"];

  afterEach(() => {
    global.fetch = originalFetch;
    process.env["PRONUNCIATION_SERVICE_URL"] = originalUrl;
  });

  it("throws when PRONUNCIATION_SERVICE_URL is not configured", async () => {
    delete process.env["PRONUNCIATION_SERVICE_URL"];

    await expect(
      getPronunciationProvider().scoreTurn(Buffer.from([1, 2, 3]), SAMPLE_PHONES),
    ).rejects.toThrow("PRONUNCIATION_SERVICE_URL is required");
  });

  it("POSTs the audio and canonical phones as multipart form data and returns the edit ops", async () => {
    process.env["PRONUNCIATION_SERVICE_URL"] = "https://pronunciation.example.test";
    let capturedUrl: string | undefined;
    let capturedForm: FormData | undefined;
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedForm = init?.body as FormData;
      return jsonResponse({
        editOps: [
          { word: "like", wordIndex: 0, op: "sub", expectedPhoneme: "L", spokenPhoneme: "R" },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await getPronunciationProvider().scoreTurn(Buffer.from([1, 2, 3]), SAMPLE_PHONES);

    expect(capturedUrl).toBe("https://pronunciation.example.test/score");
    expect(capturedForm?.get("canonical_phones")).toBe(JSON.stringify(SAMPLE_PHONES));
    const audioPart = capturedForm?.get("audio");
    expect(audioPart).toBeInstanceOf(Blob);
    expect(result).toEqual([
      { word: "like", wordIndex: 0, op: "sub", expectedPhoneme: "L", spokenPhoneme: "R" },
    ]);
  });

  it("throws with the response status and body on a non-2xx response", async () => {
    process.env["PRONUNCIATION_SERVICE_URL"] = "https://pronunciation.example.test";
    global.fetch = vi.fn(
      async () => new Response("model unavailable", { status: 503 }),
    ) as unknown as typeof fetch;

    await expect(
      getPronunciationProvider().scoreTurn(Buffer.from([1, 2, 3]), SAMPLE_PHONES),
    ).rejects.toThrow("503");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kalli/server test -- pronunciation.test.ts`
Expected: FAIL with "Cannot find module './pronunciation.js'".

- [ ] **Step 3: Implement `pronunciation.ts`**

```ts
// apps/server/src/pronunciation.ts
import type { PronunciationEditOpKind } from "@kalli/types";
import type { CanonicalWord } from "./g2p.js";

/** One detected pronunciation deviation for a word at a specific position in the turn's
 * transcript, as returned by the pronunciation-scoring service. */
export interface PronunciationEditOp {
  word: string;
  wordIndex: number;
  op: PronunciationEditOpKind;
  expectedPhoneme: string;
  spokenPhoneme: string | null;
}

export interface PronunciationProvider {
  /** Scores a turn's audio against its canonical (target-accent) phone sequence, returning every
   * detected deviation. */
  scoreTurn(audio: Buffer, canonicalPhones: CanonicalWord[]): Promise<PronunciationEditOp[]>;
}

function getServiceUrl(): string {
  const url = process.env["PRONUNCIATION_SERVICE_URL"];
  if (!url) {
    throw new Error("PRONUNCIATION_SERVICE_URL is required (see apps/server/.env.example)");
  }
  return url;
}

interface ScoreTurnResponseBody {
  editOps: PronunciationEditOp[];
}

class HttpPronunciationProvider implements PronunciationProvider {
  async scoreTurn(audio: Buffer, canonicalPhones: CanonicalWord[]): Promise<PronunciationEditOp[]> {
    const form = new FormData();
    form.append("audio", new Blob([audio], { type: "audio/webm" }), "turn.webm");
    form.append("canonical_phones", JSON.stringify(canonicalPhones));

    const response = await fetch(`${getServiceUrl()}/score`, { method: "POST", body: form });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Pronunciation service request failed: ${response.status} ${body}`);
    }
    const parsed = (await response.json()) as ScoreTurnResponseBody;
    return parsed.editOps;
  }
}

let provider: PronunciationProvider | undefined;

/** Returns the swappable pronunciation-scoring provider used by the turn pipeline. */
export function getPronunciationProvider(): PronunciationProvider {
  provider ??= new HttpPronunciationProvider();
  return provider;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kalli/server test -- pronunciation.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Document the new env var**

Add to `apps/server/.env.example`, near the other vendor URLs/keys:

```
# Base URL of the pronunciation-scoring service (see apps/pronunciation-service/, built separately)
PRONUNCIATION_SERVICE_URL=
```

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm --filter @kalli/server typecheck && pnpm --filter @kalli/server exec oxlint src/pronunciation.ts src/pronunciation.test.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/pronunciation.ts apps/server/src/pronunciation.test.ts apps/server/.env.example
git commit -m "Add pronunciation-scoring vendor adapter"
```

---

## Task 5: Widen pass 2 to accept pronunciation errors

**Files:**
- Modify: `apps/server/src/llm.ts`
- Modify: `apps/server/src/llm.test.ts`

**Interfaces:**
- Consumes: `DetectedPronunciationError` from Task 2 (`@kalli/types`).
- Produces: `LLMProvider.generateReply(history, errors, pronunciationErrors, systemPrompt):
  ReplyStream` (signature change — `pronunciationErrors: DetectedPronunciationError[]` inserted
  before `systemPrompt`) — consumed by Task 6 (`session.ts`).

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/src/llm.test.ts` (find the existing `describe("buildReplySystemPrompt"...)`
block's imports/setup at the top of the file and add these new cases in a new `describe` block near
it):

```ts
describe("generateReply with pronunciation errors", () => {
  it("includes a flagged pronunciation error in the prompt sent to the model", async () => {
    aiTestState.streamTextCalls.length = 0;
    const provider = getLLMProvider();

    const stream = provider.generateReply(
      [{ role: "user", content: "he rike it" }],
      [],
      [{ word: "like", op: "sub", expectedPhoneme: "L", spokenPhoneme: "R" }],
      SAMPLE_SYSTEM_PROMPT,
    );
    for await (const _ of stream.textStream) {
      // drain
    }

    const call = aiTestState.streamTextCalls.at(-1);
    const lastMessage = call?.messages?.at(-1);
    const content = lastMessage?.content;
    expect(Array.isArray(content)).toBe(true);
    const text = (content as { text: string }[]).map((part) => part.text).join("");
    expect(text).toContain("like");
    expect(text).toContain("L");
    expect(text).toContain("R");
  });

  it("omits the pronunciation-error block when the list is empty", async () => {
    aiTestState.streamTextCalls.length = 0;
    const provider = getLLMProvider();

    const stream = provider.generateReply(
      [{ role: "user", content: "he likes it" }],
      [],
      [],
      SAMPLE_SYSTEM_PROMPT,
    );
    for await (const _ of stream.textStream) {
      // drain
    }

    const call = aiTestState.streamTextCalls.at(-1);
    const lastMessage = call?.messages?.at(-1);
    const content = lastMessage?.content;
    const text = Array.isArray(content) ? (content as { text: string }[]).map((p) => p.text).join("") : "";
    expect(text).not.toContain("Flagged pronunciation");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kalli/server test -- llm.test.ts`
Expected: FAIL — `generateReply` currently takes 3 arguments, not 4; TypeScript will also fail to
compile until Step 3 lands.

- [ ] **Step 3: Widen `generateReply` and the error-context builder**

In `apps/server/src/llm.ts`:

Add `DetectedPronunciationError` to the existing `@kalli/types` import line.

Add a second formatter next to the existing `buildErrorContext`:

```ts
/**
 * Formats the current turn's detected pronunciation errors as a trailing block, analogous to
 * `buildErrorContext` for grammar errors — appended after the transcript, not into the system
 * prompt, since this also varies turn to turn. Returns "" when there's nothing to flag.
 */
function buildPronunciationErrorContext(errors: DetectedPronunciationError[]): string {
  if (errors.length === 0) return "";
  const errorList = errors
    .map((error) => {
      const spoken = error.spokenPhoneme ?? "(nothing)";
      return `- "${error.word}": expected /${error.expectedPhoneme}/, said /${spoken}/ (${error.op})`;
    })
    .join("\n");
  return `\n\nFlagged pronunciation errors in the message above:\n${errorList}`;
}
```

Update `toCacheableMessages` to accept and fold in the new list:

```ts
function toCacheableMessages(
  history: ConversationMessage[],
  errors: DetectedError[],
  pronunciationErrors: DetectedPronunciationError[],
): ModelMessage[] {
  const priorTurns = history.slice(0, -1);
  const currentTurn = history.at(-1);
  if (!currentTurn) return priorTurns;

  const errorContext = buildErrorContext(errors) + buildPronunciationErrorContext(pronunciationErrors);
  const content = [
    {
      type: "text" as const,
      text: currentTurn.content,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } },
    },
    ...(errorContext ? [{ type: "text" as const, text: errorContext }] : []),
  ];
  const currentMessage: ModelMessage =
    currentTurn.role === "user" ? { role: "user", content } : { role: "assistant", content };
  return [...priorTurns, currentMessage];
}
```

Update the `LLMProvider` interface and `AnthropicLLMProvider.generateReply`:

```ts
export interface LLMProvider {
  analyzeErrors(transcript: string, l1: L1): Promise<AnalysisResult>;
  generateReply(
    history: ConversationMessage[],
    errors: DetectedError[],
    pronunciationErrors: DetectedPronunciationError[],
    systemPrompt: string,
  ): ReplyStream;
}
```

```ts
  generateReply(
    history: ConversationMessage[],
    errors: DetectedError[],
    pronunciationErrors: DetectedPronunciationError[],
    systemPrompt: string,
  ): ReplyStream {
    const model = getReplyModelId();
    const result = streamText({
      model: getClient()(model),
      system: systemPrompt,
      messages: toCacheableMessages(history, errors, pronunciationErrors),
      maxOutputTokens: REPLY_MAX_OUTPUT_TOKENS,
    });
    const usage = Promise.resolve(result.usage).then(toTokenUsage);
    return { textStream: result.textStream, usage, model };
  }
```

Update `buildReplySystemPrompt`'s instruction text (in the returned template string) so the model
knows both lists can appear — replace the existing "If the learner's last message had flagged
grammar errors..." paragraph with:

```ts
    "If the learner's last message had flagged grammar or pronunciation errors, they're listed " +
    "after the message below. Pick the single most relevant one — from either list — and weave " +
    "a brief, natural spoken correction into your reply — don't list every error or lecture. If " +
    `none are listed, reply naturally with no correction.\n\n${NO_ERROR_EXAMPLE}\n` +
    `${ERROR_PRESENT_EXAMPLES}\n\n${EMPHASIS_INSTRUCTION}`
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kalli/server test -- llm.test.ts`
Expected: PASS, including the two new tests and every pre-existing test in the file (their
`generateReply` call sites will need updating — see Step 5).

- [ ] **Step 5: Fix pre-existing call sites broken by the signature change**

`llm.test.ts` has other direct/indirect `generateReply` calls from before this change (e.g. any test
that calls `getLLMProvider().generateReply(...)` with the old 3-argument shape). Search the file:

Run: `grep -n "generateReply(" apps/server/src/llm.test.ts`

Add `[]` as the third argument (empty pronunciation-errors list) to every pre-existing call found,
immediately before the `systemPrompt` argument, so each becomes a 4-argument call. Re-run the full
test file (Step 4's command) until it passes with no regressions.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm --filter @kalli/server typecheck && pnpm --filter @kalli/server exec oxlint src/llm.ts src/llm.test.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/llm.ts apps/server/src/llm.test.ts
git commit -m "Widen pass 2 to weave in pronunciation corrections"
```

---

## Task 6: Wire the pronunciation pass into the turn pipeline

**Files:**
- Modify: `apps/server/src/routes/session.ts`
- Modify: `apps/server/src/routes/session.test.ts`

**Interfaces:**
- Consumes: `g2p`/`CanonicalWord` (Task 1), `PersistedPronunciationError`/
  `DetectedPronunciationError`/the `turn_pronunciation_errors` message (Task 2),
  `turnPronunciationErrors` table (Task 3), `getPronunciationProvider`/`PronunciationEditOp` (Task
  4), the widened `generateReply` (Task 5).
- Produces: nothing new for other tasks — this is the top of the call graph for this plan.

- [ ] **Step 1: Add a pronunciation-provider fake to the test file**

In `apps/server/src/routes/session.test.ts`, add a new hoisted test-state block, modeled on
`llmTestState`, directly after it:

```ts
import type { PronunciationEditOp } from "../pronunciation.js";

const pronunciationTestState = vi.hoisted(() => {
  let scoreImpl: (audio: Buffer) => Promise<PronunciationEditOp[]> = async () => [];
  const scoreCalls: Buffer[] = [];

  return {
    reset: (): void => {
      scoreImpl = async () => [];
      scoreCalls.length = 0;
    },
    setScoreImpl: (fn: (audio: Buffer) => Promise<PronunciationEditOp[]>): void => {
      scoreImpl = fn;
    },
    getScoreCalls: (): Buffer[] => scoreCalls,
    getPronunciationProvider: vi.fn(() => ({
      scoreTurn: async (audio: Buffer) => {
        scoreCalls.push(audio);
        return scoreImpl(audio);
      },
    })),
  };
});

vi.mock("../pronunciation.js", () => ({
  getPronunciationProvider: pronunciationTestState.getPronunciationProvider,
}));
```

Find the existing `llmTestState.reset()` call in the file's shared `afterEach`/`beforeEach` setup
(search `llmTestState.reset()`) and add `pronunciationTestState.reset();` on the next line, so every
test starts from a clean fake.

Update the existing `generateReply` fake inside `llmTestState` (the `vi.mock("../llm.js", ...)`
block) to accept and record the new third argument, matching Task 5's widened signature:

```ts
      generateReply: (
        history: ConversationMessage[],
        errors: DetectedError[],
        pronunciationErrors: DetectedPronunciationError[],
      ) => {
        calls.push(history);
        replyErrorArgs.push(errors);
        replyPronunciationErrorArgs.push(pronunciationErrors);
        const textPromise = replyImpl(history, errors);
        async function* textStream(): AsyncGenerator<string> {
          yield await textPromise;
        }
        const usage = textPromise.then(() => replyUsage);
        usage.catch(() => {});
        return { textStream: textStream(), usage, model: MOCK_REPLY_MODEL };
      },
```

Add `replyPronunciationErrorArgs: DetectedPronunciationError[][] = []` alongside the existing
`replyErrorArgs` array declaration inside `llmTestState`, reset it in `reset()`, and expose it via a
new `getReplyPronunciationErrorArgs: (): DetectedPronunciationError[][] => replyPronunciationErrorArgs`
method, mirroring `getReplyErrorArgs` exactly. Import `DetectedPronunciationError` from
`@kalli/types` at the top of the test file.

- [ ] **Step 2: Write the failing tests**

Add a new `describe` block to `session.test.ts`, placed directly after the existing
`describe("two-pass correction pipeline", ...)` block:

This repo's existing WS-seam tests all follow one exact shape (see `describe("correction text
panel", ...)` at `session.test.ts:1350`): `giveConsent()` to set up a consented, onboarded user;
`buildApp()` + `app.injectWS("/api/session", { headers: { authorization: "Bearer
test-user-session-456" } })` to open the socket; `mixedQueue(ws)` to drain JSON/binary frames in
order; `drainSpokenLine(queue)` to skip the opening greeting; `ws.send(Buffer.from([...]))` for
binary audio chunks; `emitEndOfTurn(transcript)` to fire the faked Deepgram `EndOfTurn` event. The
wire order for a turn with errors is: `transcript`, `end_of_turn`, `reply_text_delta`, 2 audio
chunks, **`turn_errors` (only if `hasErrors`)**, `reply_text`, (audio), `reply_audio_end` — confirmed
directly from the `correction text panel` tests, which assert `turn_errors` arrives immediately
before `reply_text`. `turn_pronunciation_errors` is sent from the same call site, directly after
`turn_errors` and still before `reply_text` (see Step 4 below), so it takes that same slot.

```ts
describe("pronunciation correction pipeline", () => {
  it("sends the turn's audio to scoreTurn and its output into generateReply", async () => {
    await giveConsent();
    pronunciationTestState.setScoreImpl(async () => [
      { word: "like", wordIndex: 0, op: "sub", expectedPhoneme: "L", spokenPhoneme: "R" },
    ]);
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started
    await drainSpokenLine(queue);

    ws.send(Buffer.from([1, 2, 3]));
    emitEndOfTurn("he rike it");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // turn_pronunciation_errors (no grammar errors, so no turn_errors frame)
    await queue.next(); // reply_text
    await queue.next(); // reply_audio_end

    expect(pronunciationTestState.getScoreCalls()).toEqual([Buffer.from([1, 2, 3])]);
    expect(llmTestState.getReplyPronunciationErrorArgs()).toEqual([
      [{ word: "like", op: "sub", expectedPhoneme: "L", spokenPhoneme: "R" }],
    ]);

    ws.terminate();
    await app.close();
  });

  it("persists pronunciation-error rows linked to the right turn and sends them to the client", async () => {
    await giveConsent();
    pronunciationTestState.setScoreImpl(async () => [
      { word: "like", wordIndex: 0, op: "sub", expectedPhoneme: "L", spokenPhoneme: "R" },
    ]);
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    const started = (await queue.next()) as {
      kind: "json";
      message: { type: "session_started"; sessionId: string };
    };
    const sessionId = started.message.sessionId;
    await drainSpokenLine(queue);

    ws.send(Buffer.from([1, 2, 3]));
    emitEndOfTurn("he rike it");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk

    const pronunciationFrame = await queue.next();
    expect(pronunciationFrame).toEqual({
      kind: "json",
      message: {
        type: "turn_pronunciation_errors",
        turnId: expect.any(String),
        createdAt: expect.any(String),
        errors: [
          {
            id: expect.any(String),
            word: "like",
            op: "sub",
            expectedPhoneme: "L",
            spokenPhoneme: "R",
          },
        ],
      },
    });

    const [turn] = await db.select().from(turns).where(eq(turns.sessionId, sessionId));
    expect(turn).toBeDefined();
    const rows = await db
      .select()
      .from(turnPronunciationErrors)
      .where(eq(turnPronunciationErrors.turnId, turn!.id));
    expect(rows).toHaveLength(1);

    ws.terminate();
    await app.close();
  });

  it("passes an empty array to generateReply and sends no pronunciation message when nothing is detected", async () => {
    await giveConsent();
    pronunciationTestState.setScoreImpl(async () => []);
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started
    await drainSpokenLine(queue);

    ws.send(Buffer.from([1, 2, 3]));
    emitEndOfTurn("he likes it");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk

    // Straight to reply_text — no turn_pronunciation_errors frame in between.
    expect(await queue.next()).toEqual({
      kind: "json",
      message: { type: "reply_text", text: "Nice job!" },
    });
    expect(llmTestState.getReplyPronunciationErrorArgs()).toEqual([[]]);

    ws.terminate();
    await app.close();
  });

  it("keeps the turn alive (grammar correction and reply still happen) when scoreTurn fails", async () => {
    await giveConsent();
    pronunciationTestState.setScoreImpl(async () => {
      throw new Error("pronunciation service unavailable");
    });
    const app = buildApp();
    await app.ready();

    const ws = await app.injectWS("/api/session", {
      headers: { authorization: "Bearer test-user-session-456" },
    });
    const queue = mixedQueue(ws);
    await queue.next(); // session_started
    await drainSpokenLine(queue);

    ws.send(Buffer.from([1, 2, 3]));
    emitEndOfTurn("he likes it");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_text — no pronunciation frame, and no error frame either
    await queue.next(); // reply_audio_end

    // The reply pipeline still ran, with an empty pronunciation-error list, unlike an
    // analyzeErrors failure (which aborts the turn entirely).
    expect(llmTestState.getCalls()).toHaveLength(1);
    expect(llmTestState.getReplyPronunciationErrorArgs()).toEqual([[]]);

    ws.terminate();
    await app.close();
  });
});
```

Add `PersistedPronunciationError` to the test file's existing `@kalli/types` import line, and
`turnPronunciationErrors` to its existing `../db/schema.js` import line (alongside `turnErrors`).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @kalli/server test -- routes/session.test.ts`
Expected: FAIL — `handleTurn` doesn't call `getPronunciationProvider` yet, so
`pronunciationTestState.getScoreCalls()` stays empty and `getReplyPronunciationErrorArgs()` doesn't
exist on the real (not-yet-updated) call site.

- [ ] **Step 4: Wire `handleTurn`**

In `apps/server/src/routes/session.ts`:

Add imports:

```ts
import { g2p } from "../g2p.js";
import { getPronunciationProvider } from "../pronunciation.js";
import type { PronunciationEditOp } from "../pronunciation.js";
import type { DetectedPronunciationError, PersistedPronunciationError } from "@kalli/types"; // add
// to the existing @kalli/types import line, don't create a second one
```

Add a converter from the wire-shaped `PronunciationEditOp` (has `wordIndex`, not needed downstream)
to the persistence-shaped `DetectedPronunciationError`, next to `persistTurn`:

```ts
function toDetectedPronunciationErrors(
  editOps: PronunciationEditOp[],
): DetectedPronunciationError[] {
  return editOps.map(({ word, op, expectedPhoneme, spokenPhoneme }) => ({
    word,
    op,
    expectedPhoneme,
    spokenPhoneme,
  }));
}
```

Update `persistTurn` to also accept and insert pronunciation errors, in the same transaction:

```ts
interface PersistedTurn {
  id: string;
  createdAt: Date;
  errors: PersistedError[];
  pronunciationErrors: PersistedPronunciationError[];
}

async function persistTurn(
  sessionId: string,
  transcript: string,
  replyText: string,
  errors: DetectedError[],
  pronunciationErrors: DetectedPronunciationError[],
): Promise<PersistedTurn> {
  return db.transaction(async (tx) => {
    const [turn] = await tx
      .insert(turns)
      .values({ sessionId, transcript, reply: replyText })
      .returning();
    if (!turn) throw new Error("Failed to insert turn record");
    let persistedErrors: PersistedError[] = [];
    if (errors.length > 0) {
      const inserted = await tx
        .insert(turnErrors)
        .values(errors.map((error) => ({ turnId: turn.id, ...error })))
        .returning();
      persistedErrors = inserted.map((row) => ({
        id: row.id,
        category: row.category,
        original: row.original,
        corrected: row.corrected,
        explanation: row.explanation,
        hasClip: false,
        bookmarked: false,
      }));
    }
    let persistedPronunciationErrors: PersistedPronunciationError[] = [];
    if (pronunciationErrors.length > 0) {
      const inserted = await tx
        .insert(turnPronunciationErrors)
        .values(pronunciationErrors.map((error) => ({ turnId: turn.id, ...error })))
        .returning();
      persistedPronunciationErrors = inserted.map((row) => ({
        id: row.id,
        word: row.word,
        op: row.op,
        expectedPhoneme: row.expectedPhoneme,
        spokenPhoneme: row.spokenPhoneme,
      }));
    }
    return {
      id: turn.id,
      createdAt: turn.createdAt,
      errors: persistedErrors,
      pronunciationErrors: persistedPronunciationErrors,
    };
  });
}
```

Add `turnPronunciationErrors` to the existing `db/schema.js` import line.

In `handleTurn`, replace the current sequential grammar-only analysis:

```ts
          let analysis: AnalysisResult;
          try {
            analysis = await getLLMProvider().analyzeErrors(transcript, resolvedL1);
          } catch (error) {
            request.log.error(error, "Failed to analyze errors");
            if (!ended) send({ type: "error", message: "Could not analyze your speech" });
            return;
          }
          const errors = analysis.errors;
          if (aborted()) return;
```

with a concurrent grammar + pronunciation analysis, where a pronunciation failure degrades to an
empty list instead of aborting the turn (deliberately different from the grammar-analysis failure
path above it, per the spec's stated asymmetry — pronunciation detection is the newer, less-proven
pass):

```ts
          const canonicalPhones = g2p(transcript);
          const [analysisResult, pronunciationResult] = await Promise.allSettled([
            getLLMProvider().analyzeErrors(transcript, resolvedL1),
            getPronunciationProvider().scoreTurn(audio, canonicalPhones),
          ]);

          if (analysisResult.status === "rejected") {
            request.log.error(analysisResult.reason, "Failed to analyze errors");
            if (!ended) send({ type: "error", message: "Could not analyze your speech" });
            return;
          }
          const analysis = analysisResult.value;
          const errors = analysis.errors;

          let pronunciationErrors: DetectedPronunciationError[] = [];
          if (pronunciationResult.status === "fulfilled") {
            pronunciationErrors = toDetectedPronunciationErrors(pronunciationResult.value);
          } else {
            request.log.error(pronunciationResult.reason, "Failed to score pronunciation");
          }
          if (aborted()) return;
```

Update the `generateReply` call site to pass the new list:

```ts
          const result = await streamReplyWithPipelinedTTS(errors, pronunciationErrors, aborted);
```

`streamReplyWithPipelinedTTS` itself needs the same threading — update its signature and its one
internal `generateReply` call:

```ts
      async function streamReplyWithPipelinedTTS(
        errors: DetectedError[],
        pronunciationErrors: DetectedPronunciationError[],
        aborted: () => boolean,
      ): Promise<
        // ... unchanged return type
      > {
        // ... unchanged body, except:
        const replyStream = getLLMProvider().generateReply(
          [...conversationHistory],
          errors,
          pronunciationErrors,
          resolvedSystemPrompt,
        );
        // ... rest unchanged
      }
```

Update the `persistTurn` call site:

```ts
          let persistedTurn: PersistedTurn;
          try {
            persistedTurn = await persistTurn(sessionId, transcript, replyText, errors, pronunciationErrors);
          } catch (error) {
            request.log.error(error, "Failed to persist turn");
            if (!ended) send({ type: "error", message: "Could not save this turn" });
            return;
          }
```

Send the new WS message between the existing `turn_errors` send and the existing `reply_text`
send — the new block fills the gap between them; `reply_text`'s own send call is unchanged:

```ts
          if (hasErrors) {
            send({
              type: "turn_errors",
              turnId: persistedTurn.id,
              createdAt: persistedTurn.createdAt.toISOString(),
              errors: persistedTurn.errors.map((error) => ({ ...error, hasClip })),
            });
          }
          if (persistedTurn.pronunciationErrors.length > 0) {
            send({
              type: "turn_pronunciation_errors",
              turnId: persistedTurn.id,
              createdAt: persistedTurn.createdAt.toISOString(),
              errors: persistedTurn.pronunciationErrors,
            });
          }
          send({ type: "reply_text", text: replyText }); // unchanged — already existed here
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @kalli/server test -- routes/session.test.ts`
Expected: PASS — every new test in this task's `describe` block, and every pre-existing test in the
file (the `persistTurn`/`streamReplyWithPipelinedTTS`/`generateReply` signature changes are
additive-in-position but change call arity, so re-run the full file, not just the new block, and
fix any other internal call site this plan's search missed).

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm --filter @kalli/server typecheck && pnpm --filter @kalli/server exec oxlint src/routes/session.ts src/routes/session.test.ts`
Expected: no errors.

- [ ] **Step 7: Run the full server test suite**

Run: `pnpm --filter @kalli/server test`
Expected: PASS, no regressions anywhere else in the suite (in particular the `barge-in support`,
`onboarding mode`, and `usage metering` describe blocks, which also exercise `handleTurn` and
`streamReplyWithPipelinedTTS` indirectly).

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/routes/session.ts apps/server/src/routes/session.test.ts
git commit -m "Wire pronunciation scoring into the turn pipeline"
```

---

## Self-review notes

- **Spec coverage:** G2P (Task 1) → data model (Tasks 2-3) → vendor adapter (Task 4) → pass-2
  widening (Task 5) → pipeline wiring/persistence/delivery (Task 6) covers every piece of the
  spec's "Architecture," "Data model," and "Pipeline integration" sections. The spec's "Hosting and
  cost" section (the Modal/`apps/pronunciation-service/` side) is explicitly out of this plan's
  scope, per the Scope Note above and the spec's own Testing section carve-out.
- **Asymmetric failure handling:** Task 6's failure-handling test asserts pronunciation failures
  degrade gracefully (matching the spec's stated asymmetry vs. grammar-analysis failures); this plan
  uses `Promise.allSettled` rather than `Promise.all` specifically to make that asymmetry possible
  without a separate try/catch around a second `Promise.all` branch.
- **Placeholder scan:** Task 6 Step 2's test code was written against the real helpers
  (`giveConsent`, `buildApp`, `app.injectWS`, `mixedQueue`, `drainSpokenLine`, `emitEndOfTurn`,
  `ws.send(Buffer.from(...))`) and the real wire order, both confirmed directly from the existing
  `correction text panel` describe block (`session.test.ts:1350`) rather than invented — no
  placeholder helper names remain.
- **Type consistency check:** `PronunciationEditOp` (Task 4, wire/service-response shape, has
  `wordIndex`) vs. `DetectedPronunciationError` (Task 2, persistence/prompt shape, no `wordIndex`)
  are deliberately different types, converted by `toDetectedPronunciationErrors` in Task 6 — matches
  the same word/phoneme/op field names throughout (`word`, `op`, `expectedPhoneme`,
  `spokenPhoneme`) with no naming drift between tasks.
