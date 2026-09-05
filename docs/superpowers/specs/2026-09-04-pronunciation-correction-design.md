# Pronunciation error detection and correction

## Problem

Kalli today only detects grammar/word-order errors (`analyzeErrors` in `apps/server/src/llm.ts`,
pass 1 of the two-pass correction pipeline) — pronunciation was explicitly deferred at MVP scoping
(`.scratch/kalli-voice-agent/spec.md`, Out of Scope: "Pronunciation/phoneme-level error scoring...
deferred to a future dedicated pronunciation-assessment backend built on a phoneme recognizer
(HuPER)"). A learner substituting /l/ for /r/, dropping a final consonant, or otherwise
mispronouncing a word gets no feedback at all today, spoken or written — only grammar/word-order
mistakes surface in Kalli's replies and the (not-yet-built) correction panel.

Commercial pronunciation-assessment APIs (Azure Speech Pronunciation Assessment, Speechace) were
evaluated and rejected: both are built on Goodness-of-Pronunciation-style scoring that forced-aligns
against the canonical (intended) phone sequence, which biases detection toward what the model
expects the speaker to say rather than what they actually said. Confirmed directly against Azure —
a Microsoft Q&A thread (`learn.microsoft.com/en-us/answers/questions/5707709`) reports a learner
saying "they" against reference text "there" scoring as correctly pronounced, which Microsoft
confirms is by design ("the pronunciation assessment model is optimized to evaluate acoustic
similarity, not strict lexical correctness... this is a model limitation, not a configuration or
SDK issue"). That failure mode is exactly the one this feature exists to catch — an L2 speaker's
/l/-/r/ (or similar) substitution — so a vendor API with this behavior defeats the product's
purpose. Speechace isn't documented with the same specificity but sits on the same GOP-family
foundation and offers no reason to expect it avoids the same bias.

## Goals

- Detect phoneme-level mispronunciations from the audio actually produced, not from what the
  transcript says the learner was trying to say — using HuPER (`arXiv:2602.01634`,
  `huper29/huper_recognizer` + `huper29/huper_corrector` on Hugging Face), a WavLM-Large-based
  phone recognizer explicitly designed to decode acoustic evidence before applying any top-down
  canonical/lexical constraint, avoiding the bias documented above.
- Detect and deliver pronunciation corrections through the exact same live-conversation flow
  grammar corrections already use: analyzed per turn, woven briefly into Kalli's spoken reply
  when it's the most relevant thing to correct, and shown in full in the (ticket 08) correction
  panel. A separate structured drill/practice mode is worth building later but is not this spec.
- Add no serial latency to the existing pipeline beyond whichever of the two analysis passes
  (grammar, pronunciation) is slower — they run concurrently, not sequentially.
- Keep vendor/inference cost negligible relative to the existing per-session baseline (Deepgram +
  Inworld + Claude — the MVP spec's original ~$0.24/session figure was modeled against ElevenLabs;
  Inworld replaced it per the since-completed TTS vendor swap, at materially lower per-character
  cost, per `apps/server/src/tts.ts`'s own pricing note (~$5–15/1M characters on Inworld's Flash
  tier). Not re-modeled here — the pronunciation feature's own cost is negligible against either
  figure).

## Non-goals

- No structured drill/practice mode (record a target word/sentence, get a score) — future work,
  per the "both eventually, live first" scoping decision.
- No L1-specific pronunciation-confusion hint sets (the grammar pass's `L1_INTERFERENCE_HINTS`
  pattern). HuPER's acoustic-evidence approach doesn't need a bias hint to detect a substitution —
  unlike the grammar pass, which is bounded by category rather than acoustic ground truth.
  L1-flavored *explanation* text ("a common pattern for Japanese speakers") is a plausible follow-up,
  not required for detection, and not built here.
- No independent second ASR pass to verify Deepgram's transcript before treating it as the
  canonical reference. Deepgram's finalized turn transcript is used as-is as the intended-word
  target; see "Known limitation" below.
- No changes to the existing grammar pipeline's detection logic, taxonomy, or L1 hints — this adds
  a second, independent analysis pass alongside it.
- No custom G2P model. Canonical phones come from CMUdict plus a small fallback for
  out-of-dictionary words (names, coinages) — not a project to get right beyond "good enough
  coverage for conversational English."

## Architecture

```
apps/server (Fly.io)                         apps/pronunciation-service (Modal, Python)
┌─────────────────────────┐                  ┌──────────────────────────────────────┐
│ handleTurn(transcript,   │                  │ HuPER Recognizer (WavLM-Large CTC)    │
│            audio)        │                  │   audio (WebM/Opus) → decode → 16kHz  │
│                           │   HTTP POST      │   mono → audio tokens                 │
│  Promise.all([            │ ───────────────▶│                                        │
│    analyzeErrors(...),    │  { audio,        │ HuPER Corrector                       │
│    scorePronunciation(...)│    canonicalPhones}   canonical phones + audio tokens    │
│  ])                       │                  │   → edit ops (KEEP/DEL/SUB/INS)       │
│                           │ ◀─────────────── │                                        │
│  g2p(transcript)          │  per-word edit   └──────────────────────────────────────┘
│    → canonicalPhones      │  ops
└─────────────────────────┘
```

Per turn, `handleTurn` (already has `transcript` and the turn's WebM/Opus `audio` buffer —
`apps/server/src/routes/session.ts:497`) does the following, unchanged from today except for one
new concurrent branch:

1. `g2p(transcript)` (new, `apps/server/src/g2p.ts`) produces a word-aligned canonical ARPAbet
   phone sequence — CMUdict lookup per word, falling back to a small rule-based/second-dictionary
   G2P for words not in CMUdict. Pure function, no I/O, not a vendor call.
2. `analyzeErrors(transcript, l1)` (existing grammar pass) and
   `getPronunciationProvider().scoreTurn(audio, canonicalPhones)` (new) run via `Promise.all` —
   neither depends on the other's result, and pass 2 needs both before it can run.
3. `scoreTurn` HTTP-POSTs the turn's raw WebM/Opus audio plus the canonical phone sequence to the
   Modal-hosted pronunciation service, and gets back a list of per-word edit ops.
4. Pass 2 (`generateReply`) gains the pronunciation error list as a second argument alongside the
   grammar error list, and picks the single most relevant correction across both pools — the same
   judgment call ticket 07 already gives it for grammar alone, just widened to two sources.
5. Pronunciation errors persist to a new table and reach the client the same way grammar errors do.

### Why the diagnosis logic lives in the Modal service, not the recognizer alone

`huper29/huper_recognizer` alone only outputs "what phones did this audio contain" — it has no
concept of a reference to compare against. `huper29/huper_corrector` is the actual diagnosis tool:
given a canonical ARPAbet phone sequence and the recognizer's audio-token representation of the
same audio, it predicts edit operations (`KEEP`/`DEL`/`SUB:PHN`/insertions) needed to turn the
canonical sequence into what was actually realized. Every non-`KEEP` op at a phoneme position is a
detected pronunciation deviation, attributable back to its word via the word-boundary indices
`g2p()` already produces. This is a scripted-mode-shaped comparison (known text → phones, compare
against audio) but arrived at through acoustic-evidence-first decoding rather than
canonically-biased forced alignment — the same distinction that ruled out Azure/Speechace.

### Known limitation: canonical reference comes from Deepgram's transcript, not ground truth

The "canonical" phones fed to the Corrector are G2P'd from Deepgram's own finalized transcript of
the turn, not an independent record of what the learner meant to say. If Deepgram's own language
model ever silently "corrects" a misheard word, the canonical target reflects that guess, not raw
intent. This does not reintroduce the Azure-style bias into *detection*: HuPER still scores the
actual acoustic realization against whatever canonical sequence it's given, regardless of whether
that sequence is itself perfectly accurate — it's scoring pronunciation quality against the best
available proxy for intended words, which is the same thing a human tutor would do (grade against
what they think you meant to say). Worth stating explicitly rather than treating as solved; not a
blocker.

## Hosting and cost

New app `apps/pronunciation-service/` — Python, bundling the Recognizer + Corrector checkpoints,
deployed to Modal (serverless GPU, T4 tier) rather than a Fly.io GPU machine.

This was a real comparison, not a default: Fly's cheapest GPU (A10, $1.50/hr) has to stay running
to serve turns with acceptable latency — Fly GPU machines have no fast-cold-start mechanism, so
scaling to zero between turns would reintroduce multi-second-plus cold starts mid-conversation.
That's a fixed ~$1,080/month floor regardless of usage. Modal bills per GPU-second with ~5-second
memory-snapshot cold starts, and scales to zero for real between sessions.

A local timing spike (`huper29/huper_recognizer`, 315.5M params, WavLM-Large CTC, run against
synthetic audio on CPU and Apple M5 GPU/MPS as a conservative stand-in for a T4 — unoptimized F32,
where a real deployment would use FP16) measured 52–186ms per turn (3–10s of audio) on GPU, a
real-time factor of ~0.017–0.019. At Modal's T4 rate ($0.000164/sec) and the spec's baseline of ~10
turns/session, that's on the order of **$0.0001–0.0003/session** for the recognizer pass alone —
even padding 20x for the unbenchmarked Corrector pass, cold-start amortization, and HTTP overhead,
it stays around $0.002–0.006/session, negligible against the existing Deepgram + Inworld + Claude
per-session baseline regardless of its exact current figure (see Goals).

`apps/server/src/pronunciation.ts` (new) is the vendor adapter, matching `deepgram.ts`/`llm.ts`/
`tts.ts`'s existing shape exactly — typed interface, lazy singleton, factory function callers
depend on instead of an SDK/fetch call directly:

```ts
export interface PronunciationEditOp {
  word: string;
  wordIndex: number;
  op: "sub" | "del" | "ins";
  expectedPhoneme: string;
  spokenPhoneme: string | null; // null for a deletion
}

export interface PronunciationProvider {
  scoreTurn(audio: Buffer, canonicalPhones: CanonicalWord[]): Promise<PronunciationEditOp[]>;
}

export function getPronunciationProvider(): PronunciationProvider { ... }
```

## Data model

`apps/server/src/g2p.ts` (new):

```ts
export interface CanonicalWord {
  word: string;
  phones: string[]; // ARPAbet
}

export function g2p(transcript: string): CanonicalWord[];
```

`packages/types/src/index.ts` gains the pronunciation-error shape, parallel to (not merged with)
`DetectedError`/`PersistedError` — the fields genuinely differ (phoneme/edit-op vs.
category/original/corrected/explanation), the same reason ticket 07 kept the grammar taxonomy in
its own module rather than folding it into something more generic:

```ts
export const PRONUNCIATION_EDIT_OPS = ["sub", "del", "ins"] as const;
export type PronunciationEditOp = (typeof PRONUNCIATION_EDIT_OPS)[number];

export interface DetectedPronunciationError {
  word: string;
  op: PronunciationEditOp;
  expectedPhoneme: string;
  spokenPhoneme: string | null;
}

export interface PersistedPronunciationError extends DetectedPronunciationError {
  id: string;
}
```

`apps/server/src/db/schema.ts` gains a sibling table to `turnErrors`, not a column addition to it:

```ts
export const pronunciationEditOpEnum = pgEnum("pronunciation_edit_op", [...PRONUNCIATION_EDIT_OPS]);

export const turnPronunciationErrors = pgTable("turn_pronunciation_errors", {
  id: uuid("id").primaryKey().defaultRandom(),
  turnId: uuid("turn_id").notNull().references(() => turns.id),
  word: text("word").notNull(),
  op: pronunciationEditOpEnum("op").notNull(),
  expectedPhoneme: text("expected_phoneme").notNull(),
  spokenPhoneme: text("spoken_phoneme"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

New drizzle migration, applied to `kalli_dev` and `kalli_test`.

## Pipeline integration

`apps/server/src/llm.ts`: `generateReply` gains a `pronunciationErrors` parameter alongside the
existing `errors` (grammar) one:

```ts
generateReply(
  history: ConversationMessage[],
  errors: DetectedError[],
  pronunciationErrors: DetectedPronunciationError[],
  systemPrompt: string,
): ReplyStream;
```

`buildReplySystemPrompt`'s appended error-list instruction extends to describe both lists and asks
the model to pick the single most relevant item across either — mirroring the existing "pick one,
don't derail the conversation" instruction, just widened from one pool to two. Empty-both still
produces the existing explicit "no correction" instruction.

`apps/server/src/routes/session.ts`, `handleTurn`:

```ts
const canonicalPhones = g2p(transcript);
const [analysis, pronunciationErrors] = await Promise.all([
  getLLMProvider().analyzeErrors(transcript, resolvedL1),
  getPronunciationProvider().scoreTurn(audio, canonicalPhones),
]);
```

A `scoreTurn` failure is treated the same way an `analyzeErrors` failure is today — logged
server-side, turn pipeline continues with an empty pronunciation-error list rather than failing the
whole turn, since a pronunciation-scoring outage shouldn't block grammar correction or the
conversation itself. (This differs slightly from today's `analyzeErrors` failure handling, which
aborts the turn — because today's `errors` result is a hard input to `generateReply` with no
existing "degrade to empty" precedent. Introducing one for the *new* pass, rather than changing the
existing grammar pass's failure behavior, keeps the blast radius of a pronunciation-service outage
smaller than a grammar-analysis outage, which seems like the right asymmetry: pronunciation
detection is the newer, less-proven part of the pipeline.)

`persistTurn` extends to also insert `turnPronunciationErrors` rows (in the same transaction as the
turn + grammar errors), and the `turn_errors` WebSocket message gains a sibling
`turn_pronunciation_errors` message, sent under the same "only if non-empty" condition grammar
errors already use. The (not-yet-built) correction panel from ticket 08 renders both message types
in the same per-turn breakdown.

## Testing

- `g2p.ts`: pure unit tests — CMUdict hits, an out-of-dictionary fallback case, multi-word
  transcripts producing correctly word-indexed phone sequences.
- `pronunciation.ts`: mocked at the HTTP-call boundary, the same "fake implementing the interface"
  pattern already used for `deepgram.ts`/`llm.ts`/`tts.ts` — real logic (the `Promise.all`
  concurrency, persistence, WS delivery, pass-2 argument threading) runs for real against the fake,
  consistent with "mock boundaries, not logic."
- `session.ts`: extend the existing two-pass-pipeline tests with a pronunciation-errors describe
  block — errors reaching `generateReply` alongside grammar errors, rows persisted linked to the
  right turn, no rows and an empty array passed to pass 2 when nothing's detected, and a
  `scoreTurn` failure keeping the turn alive (grammar correction and the reply still happen) rather
  than aborting it, unlike an `analyzeErrors` failure.
- `apps/pronunciation-service/`: Python-side tests are out of scope for this design's frontend/
  backend TS test seam — covered separately when that app is built, following whatever test
  convention is standard for the Modal/Python side (no existing prior art in this repo to match).

## Further notes

- The HuPER Corrector's exact per-call latency wasn't benchmarked in the spike (its custom
  inference code wasn't worth spinning up for a quick timing check) — only the Recognizer was
  measured directly. The 20x padding in the cost estimate above is meant to absorb this along with
  other unmeasured overhead, but a real number is worth getting once `apps/pronunciation-service/`
  exists, ahead of any actual cost commitment.
- Confirming Speechace specifically exhibits the same canonical-bias behavior as Azure (rather than
  inferring it from the shared GOP-family lineage) wasn't done — this design would still be
  self-hosted HuPER regardless of that answer, so it wasn't worth the research time. Worth doing
  only if a future need arises to justify the choice more rigorously to a third party.
