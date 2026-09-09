# Flux Transcript-Revision Pronunciation Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect pronunciation deviations that Deepgram Flux's language model smoothed over
mid-turn (e.g. "berry" revised to "very") by comparing a turn's final transcript against the
earlier transcript hypotheses Flux emitted for that same turn, and feed any detected deviation
into the existing pronunciation-error pipeline as a tagged, independent source.

**Architecture:** `session.ts` accumulates every distinct transcript Flux emits for a turn
(`StartOfTurn`/`Update`/`EagerEndOfTurn`/`TurnResumed`), resetting at each new `StartOfTurn`. At
`EndOfTurn`, a new pure function (`pronunciationRevisionDetector.ts`) compares the final transcript
against that history word-by-word (same-word-count transcripts only), flags positions whose
canonical phone sequences differ by exactly one substitution, and emits
`DetectedPronunciationError`s tagged `source: "transcript_revision"`. These merge with the
(currently always-empty, pending HuPER) audio-based detections already tagged `source: "audio"`,
through the same `generateReply`/persistence/WebSocket path grammar errors already use.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM/PostgreSQL, Vitest — all existing, no new
dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-flux-transcript-revision-detection-design.md`

## Global Constraints

- No L1-specific confusion-pair list (e.g. no hardcoded b/v, l/r table) — the filter is generic
  phone-sequence edit distance, not a curated pair list.
- Only same-word-count prior transcripts are compared; a revision that also changes word count is
  skipped entirely for this feature (no diff/alignment algorithm).
- Starting cutoff (a first guess, expected to be revised against real session data): the two
  words' canonical phone sequences must be the same length and differ at exactly one position.
  Anything else is discarded as unrelated ASR noise.
- Every emitted `DetectedPronunciationError` carries a `source: "audio" | "transcript_revision"`
  field — this feature only ever produces `"transcript_revision"`; the existing HuPER path
  (`pronunciation.ts`) is tagged `"audio"`.
- No new vendor/network calls, no new environment variables — pure TypeScript, computed from data
  already flowing through `session.ts`.

---

## Task 1: Shared types and the pure revision detector

**Files:**
- Modify: `packages/types/src/index.ts`
- Create: `apps/server/src/pronunciationRevisionDetector.ts`
- Test: `apps/server/src/pronunciationRevisionDetector.test.ts`

**Interfaces:**
- Consumes: `g2p(transcript: string): CanonicalWord[]` from `apps/server/src/g2p.ts` (existing,
  unchanged) — `CanonicalWord` is `{ word: string; phones: string[] }`.
- Produces: `export function detectAsrSmoothedDeviations(finalTranscript: string, priorTranscripts: string[]): DetectedPronunciationError[]`,
  and `export const PRONUNCIATION_ERROR_SOURCES = ["audio", "transcript_revision"] as const` /
  `export type PronunciationErrorSource = (typeof PRONUNCIATION_ERROR_SOURCES)[number]` from
  `@kalli/types`, consumed by Tasks 2 and 3.

- [ ] **Step 1: Add the `source` field to the shared pronunciation-error types**

In `packages/types/src/index.ts`, replace the existing `DetectedPronunciationError` interface
(currently just above `PersistedPronunciationError`) with:

```ts
export const PRONUNCIATION_ERROR_SOURCES = ["audio", "transcript_revision"] as const;

export type PronunciationErrorSource = (typeof PRONUNCIATION_ERROR_SOURCES)[number];

/** One detected pronunciation deviation for a single word in a turn — e.g. a substituted phoneme
 * (an L2 /l/-for-/r/ swap), a dropped phoneme, or an inserted one. `source` distinguishes HuPER's
 * audio-verified detections from ones inferred purely from Flux revising its own transcript
 * mid-turn (see docs/superpowers/specs/2026-09-05-flux-transcript-revision-detection-design.md). */
export interface DetectedPronunciationError {
  word: string;
  op: PronunciationEditOpKind;
  expectedPhoneme: string;
  /** The phoneme actually realized in the audio, or `null` for a deletion (nothing was spoken in
   * its place). */
  spokenPhoneme: string | null;
  source: PronunciationErrorSource;
}
```

(`PersistedPronunciationError extends DetectedPronunciationError` below it needs no change — it
inherits `source` automatically.)

- [ ] **Step 2: Write the failing tests for the detector**

Create `apps/server/src/pronunciationRevisionDetector.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectAsrSmoothedDeviations } from "./pronunciationRevisionDetector.js";

describe("detectAsrSmoothedDeviations", () => {
  it("flags a word Flux revised to a phonetically close real word by EndOfTurn", () => {
    const result = detectAsrSmoothedDeviations("I had a very good day", ["I had a berry good day"]);

    expect(result).toEqual([
      {
        word: "very",
        op: "sub",
        expectedPhoneme: "V",
        spokenPhoneme: "B",
        source: "transcript_revision",
      },
    ]);
  });

  it("ignores a prior transcript with a different word count than the final one", () => {
    const result = detectAsrSmoothedDeviations("I need to cancel please", ["I need to cancel"]);

    expect(result).toEqual([]);
  });

  it("discards a revision where the words' phone sequences have different lengths", () => {
    const result = detectAsrSmoothedDeviations("to fly", ["for fly"]);

    expect(result).toEqual([]);
  });

  it("dedupes when multiple prior transcripts flag the same word position", () => {
    const result = detectAsrSmoothedDeviations("I had a very good day", [
      "I had a berry good day",
      "I had a berry good day",
    ]);

    expect(result).toHaveLength(1);
  });

  it("returns an empty array when no prior transcript differs from the final one", () => {
    expect(detectAsrSmoothedDeviations("hello Kalli", ["hello Kalli"])).toEqual([]);
  });

  it("returns an empty array when there are no prior transcripts at all", () => {
    expect(detectAsrSmoothedDeviations("hello Kalli", [])).toEqual([]);
  });
});
```

These exact phone sequences were verified directly against the installed `phonemize` package
before writing this plan: `berry` → `B EH R IY`, `very` → `V EH R IY` (single substitution at
index 0), `for` → `F AA R` (3 phones), `to` → `T UW` (2 phones, different length).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/server && pnpm exec vitest run src/pronunciationRevisionDetector.test.ts`
Expected: FAIL with "Cannot find module './pronunciationRevisionDetector.js'"

- [ ] **Step 4: Implement the detector**

Create `apps/server/src/pronunciationRevisionDetector.ts`:

```ts
import type { DetectedPronunciationError } from "@kalli/types";
import { g2p } from "./g2p.js";

/**
 * Finds words Flux's finalized transcript smoothed over mid-turn: a prior transcript hypothesis
 * for the same turn differed from the final one at a word position, and the two words' canonical
 * phone sequences differ by exactly one substitution — the shape of a real L1-interference swap
 * (e.g. "berry"/"very" for a Spanish speaker's b/v confusion), not unrelated ASR noise.
 * See docs/superpowers/specs/2026-09-05-flux-transcript-revision-detection-design.md.
 */
export function detectAsrSmoothedDeviations(
  finalTranscript: string,
  priorTranscripts: string[],
): DetectedPronunciationError[] {
  const finalWords = g2p(finalTranscript);
  const flaggedIndices = new Set<number>();
  const deviations: DetectedPronunciationError[] = [];

  for (const prior of priorTranscripts) {
    const priorWords = g2p(prior);
    if (priorWords.length !== finalWords.length) continue;

    for (let i = 0; i < finalWords.length; i++) {
      if (flaggedIndices.has(i)) continue;
      const finalWord = finalWords[i];
      const priorWord = priorWords[i];
      if (!finalWord || !priorWord) continue;
      if (finalWord.word.toLowerCase() === priorWord.word.toLowerCase()) continue;

      const substitution = singlePhoneSubstitution(finalWord.phones, priorWord.phones);
      if (!substitution) continue;

      flaggedIndices.add(i);
      deviations.push({
        word: finalWord.word,
        op: "sub",
        expectedPhoneme: substitution.expectedPhoneme,
        spokenPhoneme: substitution.spokenPhoneme,
        source: "transcript_revision",
      });
    }
  }

  return deviations;
}

/**
 * Returns the single differing phone pair if two phone sequences are the same length and differ
 * at exactly one position, or `null` for a different length or more than one differing position —
 * both treated as unrelated ASR noise rather than a pronunciation cue.
 */
function singlePhoneSubstitution(
  finalPhones: string[],
  priorPhones: string[],
): { expectedPhoneme: string; spokenPhoneme: string } | null {
  if (finalPhones.length === 0 || finalPhones.length !== priorPhones.length) return null;

  let diffIndex = -1;
  for (let i = 0; i < finalPhones.length; i++) {
    if (finalPhones[i] !== priorPhones[i]) {
      if (diffIndex !== -1) return null;
      diffIndex = i;
    }
  }
  if (diffIndex === -1) return null;

  const expectedPhoneme = finalPhones[diffIndex];
  const spokenPhoneme = priorPhones[diffIndex];
  if (!expectedPhoneme || !spokenPhoneme) return null;
  return { expectedPhoneme, spokenPhoneme };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/server && pnpm exec vitest run src/pronunciationRevisionDetector.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Typecheck both touched packages**

Run: `cd packages/types && pnpm typecheck && cd ../../apps/server && pnpm typecheck`
Expected: no errors. (`apps/server`'s other files that construct `DetectedPronunciationError`
without `source` will fail here — that's expected; Tasks 2–3 fix each one. If this is run in
isolation before those tasks, ignore errors outside `pronunciationRevisionDetector.ts`.)

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/index.ts apps/server/src/pronunciationRevisionDetector.ts apps/server/src/pronunciationRevisionDetector.test.ts
git commit -m "Add transcript-revision pronunciation-deviation detector"
```

---

## Task 2: Database column for error source

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/db/schema.test.ts`
- Create: new migration under `apps/server/drizzle/` (generated, not hand-written)

**Interfaces:**
- Consumes: `PRONUNCIATION_ERROR_SOURCES` from `@kalli/types` (Task 1).
- Produces: `turnPronunciationErrors.source` column (drizzle-inferred type
  `PronunciationErrorSource`), consumed by Task 3's `persistTurn`.

- [ ] **Step 1: Add the enum and column to the schema**

In `apps/server/src/db/schema.ts`, add `PRONUNCIATION_ERROR_SOURCES` to the existing `@kalli/types`
import:

```ts
import {
  ERROR_CATEGORIES,
  L1_VALUES,
  PROFICIENCY_LEVELS,
  PRONUNCIATION_EDIT_OPS,
  PRONUNCIATION_ERROR_SOURCES,
  SESSION_END_REASONS,
} from "@kalli/types";
```

Then, right after the existing `pronunciationEditOpEnum` declaration, add:

```ts
export const pronunciationErrorSourceEnum = pgEnum("pronunciation_error_source", [
  ...PRONUNCIATION_ERROR_SOURCES,
]);
```

And add a `source` column to `turnPronunciationErrors`, right after `spokenPhoneme`:

```ts
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
```

- [ ] **Step 2: Update the existing schema round-trip tests to supply `source`**

In `apps/server/src/db/schema.test.ts`, both `turnPronunciationErrors` insert calls are missing
the new required column. Update the first (`"round-trips a row linked to a turn"`):

```ts
    const [error] = await db
      .insert(turnPronunciationErrors)
      .values({
        turnId: turn.id,
        word: "like",
        op: "sub",
        expectedPhoneme: "L",
        spokenPhoneme: "R",
        source: "audio",
      })
      .returning();

    expect(error).toMatchObject({
      turnId: turn.id,
      word: "like",
      op: "sub",
      expectedPhoneme: "L",
      spokenPhoneme: "R",
      source: "audio",
    });
```

And the second (`"allows a null spokenPhoneme for a deletion"`):

```ts
    const [error] = await db
      .insert(turnPronunciationErrors)
      .values({
        turnId: turn.id,
        word: "as",
        op: "del",
        expectedPhoneme: "Z",
        spokenPhoneme: null,
        source: "transcript_revision",
      })
      .returning();
```

- [ ] **Step 3: Generate and apply the migration**

Run: `cd apps/server && pnpm db:generate`
Expected: a new file appears under `apps/server/drizzle/` adding the `pronunciation_error_source`
enum and the `source` column (NOT NULL, no default — safe because no code path has ever inserted
into `turn_pronunciation_errors` in any environment: `PRONUNCIATION_SERVICE_URL` is unset and
`apps/pronunciation-service` doesn't exist yet, so the table has zero rows everywhere).

Run: `pnpm db:migrate`
Expected: migration applies cleanly against the local dev/test databases.

- [ ] **Step 4: Run the schema tests to verify they pass**

Run: `pnpm exec vitest run src/db/schema.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/schema.test.ts apps/server/drizzle/
git commit -m "Add source column to turn_pronunciation_errors"
```

---

## Task 3: Wire transcript-revision history into the turn pipeline

**Files:**
- Modify: `apps/server/src/routes/session.ts`
- Modify: `apps/server/src/routes/session.test.ts`

**Interfaces:**
- Consumes: `detectAsrSmoothedDeviations(finalTranscript, priorTranscripts)` (Task 1).
- Produces: `handleTurn(transcript, audio, priorTranscripts)` and
  `analyzeTurn(transcript, l1, audio, priorTranscripts, log)` — both gain a third/fourth
  `priorTranscripts: string[]` parameter; no other file calls either function.

- [ ] **Step 1: Write the failing integration tests**

In `apps/server/src/routes/session.test.ts`, inside the existing
`describe("pronunciation correction pipeline", ...)` block, add two tests after the last one
(`"keeps the turn alive... when scoreTurn fails"`):

```ts
  it("flags a mid-turn transcript revision as a pronunciation error", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    emitStartOfTurn("I had a berry good day");
    await queue.next(); // transcript (isFinal: false, from StartOfTurn)
    emitEndOfTurn("I had a very good day");
    await queue.next(); // transcript (isFinal: true)
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
            word: "very",
            op: "sub",
            expectedPhoneme: "V",
            spokenPhoneme: "B",
            source: "transcript_revision",
          },
        ],
      },
    });
    await queue.next(); // reply_text
    await queue.next(); // reply_audio_end

    ws.terminate();
    await app.close();
  });

  it("does not leak a completed turn's transcript history into the next turn", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    emitStartOfTurn("I had a berry good day");
    await queue.next(); // transcript
    emitEndOfTurn("I had a very good day");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // turn_pronunciation_errors
    await queue.next(); // reply_text
    await queue.next(); // reply_audio_end

    emitEndOfTurn("I had a very good day");
    await queue.next(); // transcript
    await queue.next(); // end_of_turn
    await queue.next(); // reply_text_delta
    await queue.next(); // audio chunk
    await queue.next(); // audio chunk
    await queue.next(); // reply_text — no turn_pronunciation_errors frame this time
    await queue.next(); // reply_audio_end

    expect(llmTestState.getReplyPronunciationErrorArgs()).toEqual([
      [
        {
          word: "very",
          op: "sub",
          expectedPhoneme: "V",
          spokenPhoneme: "B",
          source: "transcript_revision",
        },
      ],
      [],
    ]);

    ws.terminate();
    await app.close();
  });
```

Then update the two *existing* pronunciation-pipeline tests, which will otherwise fail once
`source` is required. In `"sends the turn's audio to scoreTurn and its output into generateReply"`:

```ts
    expect(llmTestState.getReplyPronunciationErrorArgs()).toEqual([
      [{ word: "like", op: "sub", expectedPhoneme: "L", spokenPhoneme: "R", source: "audio" }],
    ]);
```

And in `"persists pronunciation-error rows linked to the right turn and sends them to the client"`,
the expected frame's error object:

```ts
        errors: [
          {
            id: expect.any(String),
            word: "like",
            op: "sub",
            expectedPhoneme: "L",
            spokenPhoneme: "R",
            source: "audio",
          },
        ],
```

- [ ] **Step 2: Run the tests to verify the new ones fail and note the existing ones also fail**

Run: `pnpm exec vitest run src/routes/session.test.ts -t "pronunciation"`
Expected: FAIL — the two new tests fail because nothing populates `turnTranscriptHistory` yet; the
two updated existing tests fail because `source` isn't produced yet.

- [ ] **Step 3: Add transcript-history tracking to the Deepgram message handler**

In `apps/server/src/routes/session.ts`, add the history array next to the existing
`turnAudioChunks` declaration (around line 345):

```ts
      const conversationHistory: ConversationMessage[] = [];
      let turnAudioChunks: Buffer[] = [];
```
becomes:
```ts
      const conversationHistory: ConversationMessage[] = [];
      let turnAudioChunks: Buffer[] = [];
      /** Every distinct transcript Flux has emitted for the turn in progress, in order — lets a
       * later `EndOfTurn` be compared against what Flux hypothesized before it settled (see
       * docs/superpowers/specs/2026-09-05-flux-transcript-revision-detection-design.md). Reset at
       * `StartOfTurn` and after `EndOfTurn` consumes it. */
      let turnTranscriptHistory: string[] = [];
```

In the `StartOfTurn` handling block (around line 850-860), reset it alongside `turnAudioChunks`:

```ts
        if (data.event === "StartOfTurn") {
          turnAudioChunks = [...preRollChunks];
          turnTranscriptHistory = [];
```

In the `EndOfTurn` block (around line 864-877), capture the history before clearing it, and pass
it to `handleTurn`:

```ts
        if (data.event === "EndOfTurn") {
          if (data.transcript) send({ type: "transcript", text: data.transcript, isFinal: true });
          send({ type: "end_of_turn" });
          const turnAudio =
            !webmHeaderChunk || turnAudioChunks[0] === webmHeaderChunk
              ? Buffer.concat(turnAudioChunks)
              : Buffer.concat([webmHeaderChunk, ...turnAudioChunks]);
          turnAudioChunks = [];
          const priorTranscripts = turnTranscriptHistory;
          turnTranscriptHistory = [];
          if (data.transcript) {
            if (onboardingFlowState) void handleOnboardingTurn(data.transcript);
            else void handleTurn(data.transcript, turnAudio, priorTranscripts);
          }
          return;
        }
```

And in the trailing block that forwards non-final transcripts (around line 879), record each
distinct one:

```ts
        if (data.transcript) {
          send({ type: "transcript", text: data.transcript, isFinal: false });
          if (turnTranscriptHistory.at(-1) !== data.transcript) {
            turnTranscriptHistory.push(data.transcript);
          }
        }
```

- [ ] **Step 4: Thread `priorTranscripts` through `handleTurn` and `analyzeTurn`, and tag/merge sources**

Add the import at the top of `session.ts`, alongside the existing `g2p` import:

```ts
import { g2p } from "../g2p.js";
import { detectAsrSmoothedDeviations } from "../pronunciationRevisionDetector.js";
```

Update `toDetectedPronunciationErrors` (around line 103) to tag the HuPER path:

```ts
function toDetectedPronunciationErrors(
  editOps: PronunciationEditOp[],
): DetectedPronunciationError[] {
  return editOps.map(({ word, op, expectedPhoneme, spokenPhoneme }) => ({
    word,
    op,
    expectedPhoneme,
    spokenPhoneme,
    source: "audio",
  }));
}
```

Update `analyzeTurn` (around line 130) to accept and use `priorTranscripts`:

```ts
async function analyzeTurn(
  transcript: string,
  l1: L1,
  audio: Buffer,
  priorTranscripts: string[],
  log: FastifyBaseLogger,
): Promise<TurnAnalysis> {
  const canonicalPhones = g2p(transcript);
  const [analysisResult, pronunciationResult] = await Promise.allSettled([
    getLLMProvider().analyzeErrors(transcript, l1),
    getPronunciationProvider().scoreTurn(audio, canonicalPhones),
  ]);

  if (analysisResult.status === "rejected") {
    log.error(analysisResult.reason, "Failed to analyze errors");
    return { failed: true };
  }

  let pronunciationErrors: DetectedPronunciationError[] = [];
  if (pronunciationResult.status === "fulfilled") {
    pronunciationErrors = toDetectedPronunciationErrors(pronunciationResult.value);
  } else {
    log.error(pronunciationResult.reason, "Failed to score pronunciation");
  }
  pronunciationErrors = [
    ...pronunciationErrors,
    ...detectAsrSmoothedDeviations(transcript, priorTranscripts),
  ];

  const analysis = analysisResult.value;
  return {
    failed: false,
    errors: analysis.errors,
    analysisUsage: analysis.usage,
    analysisModel: analysis.model,
    pronunciationErrors,
  };
}
```

Update `handleTurn`'s signature and its call to `analyzeTurn` (around lines 613 and 637):

```ts
      async function handleTurn(
        transcript: string,
        audio: Buffer,
        priorTranscripts: string[],
      ): Promise<void> {
```

```ts
          const analysis = await analyzeTurn(
            transcript,
            resolvedL1,
            audio,
            priorTranscripts,
            request.log,
          );
```

Update `persistTurn`'s row-mapping (around line 219-231) to carry `source` through from the
inserted row:

```ts
      persistedPronunciationErrors = inserted.map((row) => ({
        id: row.id,
        word: row.word,
        op: row.op,
        expectedPhoneme: row.expectedPhoneme,
        spokenPhoneme: row.spokenPhoneme,
        source: row.source,
      }));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/routes/session.test.ts -t "pronunciation"`
Expected: PASS (6 tests: 4 existing + 2 new)

- [ ] **Step 6: Run the full server test suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/session.ts apps/server/src/routes/session.test.ts
git commit -m "Merge transcript-revision detections into the turn pipeline"
```

---

## Task 4: Tentative reply phrasing for inferred (non-audio) detections

**Files:**
- Modify: `apps/server/src/llm.ts`
- Modify: `apps/server/src/llm.test.ts`

**Interfaces:**
- Consumes: `DetectedPronunciationError.source` (Task 1).
- Produces: no new exports — `buildPronunciationErrorContext`'s output text changes based on
  `source`; `generateReply`'s public signature is unchanged.

- [ ] **Step 1: Update the existing test and write the new one**

In `apps/server/src/llm.test.ts`, the existing pronunciation-error test constructs an error object
missing `source` (around line 298) — update it:

```ts
      [{ word: "like", op: "sub", expectedPhoneme: "L", spokenPhoneme: "R", source: "audio" }],
```

Add a new test in the same `describe("generateReply with pronunciation errors", ...)` block, right
after the existing `"includes a flagged pronunciation error in the prompt sent to the model"` test:

```ts
  it("phrases a transcript-revision-sourced error more tentatively than an audio-sourced one", async () => {
    aiTestState.streamTextCalls.length = 0;
    const provider = getLLMProvider();

    const stream = provider.generateReply(
      [{ role: "user", content: "I had a very good day" }],
      [],
      [
        {
          word: "very",
          op: "sub",
          expectedPhoneme: "V",
          spokenPhoneme: "B",
          source: "transcript_revision",
        },
      ],
      SAMPLE_SYSTEM_PROMPT,
    );
    for await (const _ of stream.textStream) {
      // drain
    }

    const call = aiTestState.streamTextCalls.at(-1);
    const lastMessage = call?.messages?.at(-1);
    const content = lastMessage?.content;
    const text = (content as { text: string }[]).map((part) => part.text).join("");
    expect(text).toContain("may have said");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/llm.test.ts -t "pronunciation"`
Expected: FAIL — the updated test fails to typecheck/compile without `source` on the call site
already fixed above; the new test fails because the prompt text doesn't yet contain "may have
said".

- [ ] **Step 3: Update `buildPronunciationErrorContext` to branch on `source`**

In `apps/server/src/llm.ts` (around line 215), replace:

```ts
function buildPronunciationErrorContext(errors: DetectedPronunciationError[]): string {
  if (errors.length === 0) return "";
  const errorList = errors
    .map((error) => {
      const spoken = error.spokenPhoneme ?? "(nothing)";
      return (
        `- "${error.word}": expected /${error.expectedPhoneme}/, said /${spoken}/ ` +
        `(${error.op})`
      );
    })
    .join("\n");
  return `\n\nFlagged pronunciation errors in the message above:\n${errorList}`;
}
```

with:

```ts
function buildPronunciationErrorContext(errors: DetectedPronunciationError[]): string {
  if (errors.length === 0) return "";
  const errorList = errors
    .map((error) => {
      const spoken = error.spokenPhoneme ?? "(nothing)";
      const evidence =
        error.source === "audio"
          ? `expected /${error.expectedPhoneme}/, said /${spoken}/`
          : `expected /${error.expectedPhoneme}/, may have said /${spoken}/ (inferred from the ` +
            `transcript revising itself mid-turn, not confirmed against the audio)`;
      return `- "${error.word}": ${evidence} (${error.op})`;
    })
    .join("\n");
  return `\n\nFlagged pronunciation errors in the message above:\n${errorList}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/llm.test.ts -t "pronunciation"`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full server test suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/llm.ts apps/server/src/llm.test.ts
git commit -m "Phrase transcript-revision pronunciation errors more tentatively"
```

---

## Task 5: Update the web client's test fixture

**Files:**
- Modify: `apps/web/src/Session.test.tsx`

**Interfaces:**
- Consumes: `PersistedPronunciationError` from `@kalli/types` (Task 1) — `Session.tsx` itself
  accesses no fields of it (its `turn_pronunciation_errors` case is a documented no-op pending the
  future correction panel), so no `Session.tsx` production-code change is needed.

- [ ] **Step 1: Update the test fixture to satisfy the new required field**

In `apps/web/src/Session.test.tsx`, the `"does not throw when the server sends
turn_pronunciation_errors"` test (around line 861) constructs an error object missing `source`:

```ts
      errors: [
        { id: "error-1", word: "like", op: "sub", expectedPhoneme: "L", spokenPhoneme: "R" },
      ],
```

Update it to:

```ts
      errors: [
        {
          id: "error-1",
          word: "like",
          op: "sub",
          expectedPhoneme: "L",
          spokenPhoneme: "R",
          source: "audio",
        },
      ],
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run src/Session.test.tsx -t "turn_pronunciation_errors"`
Expected: PASS

- [ ] **Step 3: Typecheck the web app**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/Session.test.tsx
git commit -m "Update pronunciation-error test fixture for the new source field"
```

---

## Task 6: Full verification and spec cleanup

**Files:**
- Modify: `docs/superpowers/specs/2026-09-05-flux-transcript-revision-detection-design.md`

- [ ] **Step 1: Fix a stray implementation detail in the spec**

The spec's Architecture section says the detector "Emits `{ word, wordIndex, op: "sub",
expectedPhoneme, spokenPhoneme, source: "transcript_revision" }`" — but `DetectedPronunciationError`
(the actual shared type, unchanged by this plan except for adding `source`) has no `wordIndex`
field; only the HuPER HTTP-boundary type (`PronunciationEditOp` in `pronunciation.ts`) has one, and
it's dropped before reaching `DetectedPronunciationError`. Update that line to:

```
- Emits `{ word, op: "sub", expectedPhoneme, spokenPhoneme, source: "transcript_revision" }`
  per surviving position.
```

- [ ] **Step 2: Run every affected package's full test suite, typecheck, and lint**

Run from the repo root:

```bash
pnpm --filter @kalli/types typecheck
pnpm --filter server test
pnpm --filter server typecheck
pnpm --filter web test
pnpm --filter web typecheck
pnpm lint
```

Expected: all pass, zero warnings.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-05-flux-transcript-revision-detection-design.md
git commit -m "Fix stray wordIndex reference in the revision-detection spec"
```
