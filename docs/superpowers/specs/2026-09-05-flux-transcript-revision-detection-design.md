# Detecting ASR-smoothed pronunciation deviations via Flux's mid-turn transcript revisions

## Problem

Confirmed via a live repro: a Spanish-L1 speaker with a classic b/v confusion said "I had a berry
good day." Deepgram Flux's live partial transcript briefly showed "I had a berry good day," then
revised to the finalized "I had a very good day" by `EndOfTurn`. `handleTurn` only ever sees the
final transcript, so `g2p("very")` produces canonical phones for "very" — the mispronunciation
never reaches any downstream scoring, and no coaching is possible for this turn regardless of
whether the HuPER pronunciation-service (`2026-09-04-pronunciation-correction-design.md`) is live.

This is not a Deepgram misconfiguration. Research done before this spec confirmed:

- Flux's `/v2/listen` query/Configure surface is fully enumerated in Deepgram's own API spec:
  `model`, `encoding`, `sample_rate`, `eager_eot_threshold`, `eot_threshold`, `eot_timeout_ms`,
  `keyterm(s)`, `language_hint(s)`, `profanity_filter`, `numerals`, `redact`, `mip_opt_out`, `tag`.
  Nothing there touches decoding bias; `smart_format` isn't a Flux parameter at all (confirmed by
  both the SDK's generated types and a live connection rejection when it was tried).
- Word output is single-best only — `word`, `confidence`, `start`, `end` — no N-best alternatives,
  no phoneme data. `confidence` doesn't help either: an LM-corrected word is often reported with
  *high* confidence precisely because the model is confident in its correction.
- This is a named, studied failure mode — "intent bias" — not a Flux quirk. A 2026 ACL BEA paper
  ("Intent vs. Surface: Recovering Acoustic Realization from Modern ASR for Pronunciation
  Training") tested 8 ASR systems across 3 architectures on two L2 English corpora and found
  overcorrection rate correlates *inversely* with WER: the more accurate the ASR, the more it
  masks mispronunciation. Its own mitigation (phoneme-similarity reranking over N-best hypotheses)
  isn't portable here since Flux exposes no N-best.
- Swapping the transcript ASR for a CTC-only, no-LM model (the architecture academic
  "error-preserving ASR" work uses, e.g. `ChaLL-300M`) was considered and rejected: such models are
  narrowly fine-tuned (that one specifically to Swiss schoolchildren's English, with its own model
  card warning against general adult/accented speech), and none replicate Flux's turn-detection/VAD
  behavior that the live conversational pipeline depends on.

What the repro *does* reveal, though: Flux's own incremental behavior handed us the "berry"
hypothesis before it revised to "very." `session.ts`'s message handler already receives every
`StartOfTurn`/`Update`/`EagerEndOfTurn`/`TurnResumed`/`EndOfTurn` event for a turn, each carrying a
`transcript` — but today only forwards intermediate transcripts to the client for live display and
discards them once `EndOfTurn` arrives (`session.ts:837-880`). The signal exists in the stream
already; it's just being thrown away.

This directly updates the "Known limitation" section of `2026-09-04-pronunciation-correction-design.md`,
which treated "Deepgram silently corrects a misheard word" as an accepted, unsolved gap. This spec
doesn't eliminate that gap, but gives a way to catch a real subset of it — using data already
flowing through the pipeline, no new vendor, no independent ASR pass.

## Goals

- Detect pronunciation deviations that Flux's transcript smoothed over, by comparing each turn's
  final transcript against the earlier transcript hypotheses Flux emitted for the same turn.
- Ship independently of the (not-yet-built) HuPER pronunciation-service — this is pure
  text/phonetics, computed in TypeScript from data already in `session.ts`. It becomes the first
  working source of pronunciation coaching in production, ahead of HuPER.
- Feed into the exact same downstream pipeline `2026-09-04-pronunciation-correction-design.md`
  already defines — `DetectedPronunciationError`, `turnPronunciationErrors`, the reply LLM's
  "pick the single most relevant correction" step, the WS `turn_pronunciation_errors` message —
  as a second, independent source alongside HuPER's (future) audio-based one, not a parallel system.
- Tag detections with their source (`"transcript_revision"` vs `"audio"`) so this heuristic,
  inferred-signal source is distinguishable from HuPER's audio-verified one, both in the reply
  prompt's phrasing and in the correction panel's provenance.

## Non-goals

- No real word-alignment (diff/LCS) between revised and final transcripts — only turns where a
  prior transcript has the *same word count* as the final one are compared, word-by-word. A
  revision that also inserts/deletes a word is skipped for v1. The target failure mode (a single
  mispronounced word) essentially never changes word count; broader alignment is future work only
  if production data shows it's needed.
- No L1-specific confusion-pair list (e.g. a hardcoded b/v, l/r table). Consistent with the
  original design's rejection of L1-specific hints for HuPER: the filter is phonetic closeness
  (ARPAbet edit distance), not a curated pair list.
- No audio confirmation before surfacing a detection. This trades precision for shipping without
  waiting on HuPER — expect both false positives (e.g. "than"/"then"-style function-word ambiguity
  that's ASR noise, not a pronunciation error) and false negatives (a mispronunciation Flux was
  confident about from its very first partial, never revised) as an accepted starting point, not a
  solved precision problem.
- No fix to HuPER's own canonical-reference limitation (canonical phones still come from the
  *final* transcript's word once HuPER ships). This is a parallel signal, not a repair of that one.
  Feeding revision-detected alternate candidates into HuPER's scoring as a second target word is a
  plausible future integration, not built here.
- No threshold tuning beyond a reasonable starting value — the exact phone-edit-distance cutoff is
  a first guess, expected to be revisited once real session data exists.

## Architecture

```
Flux TurnInfo stream                          session.ts                         pronunciationRevisionDetector.ts
┌─────────────────────┐   StartOfTurn         ┌───────────────────────┐         ┌──────────────────────────────┐
│ StartOfTurn          │──────────────────────▶│ turnTranscriptHistory │         │ detectAsrSmoothedDeviations(  │
│ Update (x N)         │   Update/EagerEot/     │   = []                │         │   finalTranscript,             │
│ EagerEndOfTurn        │   TurnResumed          │ (push each distinct   │         │   priorTranscripts,            │
│ TurnResumed           │──────────────────────▶│  transcript)          │         │ ): DetectedPronunciationError[]│
│ EndOfTurn             │   EndOfTurn            │                       │──────▶ │                                │
└─────────────────────┘──────────────────────▶│ merge into             │◀──────  │ tokenize (g2p's splitter)      │
                                                 │ pronunciationErrors   │         │ same-length priors only        │
                                                 │ (alongside HuPER's,   │         │ word-by-word diff              │
                                                 │  once that exists)    │         │ g2p both words, phone edit-    │
                                                 └───────────────────────┘         │   distance filter               │
                                                                                    │ dedupe by wordIndex            │
                                                                                    │ tag source: "transcript_revision"│
                                                                                    └──────────────────────────────┘
```

`session.ts` changes:

1. Add `let turnTranscriptHistory: string[] = []`, reset alongside the existing
   `turnAudioChunks = [...preRollChunks]` reset at `StartOfTurn` (`session.ts:851`).
2. On every `TurnInfo` message where `data.transcript` is non-empty and the event isn't
   `EndOfTurn`, push it onto `turnTranscriptHistory` if it differs from the last entry (avoid
   growing the array on repeated identical partials).
3. At `EndOfTurn` (`session.ts:864`), before clearing state: call
   `detectAsrSmoothedDeviations(data.transcript, turnTranscriptHistory)` and merge its result into
   the `pronunciationErrors` array assembled in the existing `Promise.allSettled` block
   (`session.ts:137-151`) — concatenated with HuPER's (future) output, not replacing it. Then reset
   `turnTranscriptHistory = []`.

New pure module `apps/server/src/pronunciationRevisionDetector.ts`:

```ts
export function detectAsrSmoothedDeviations(
  finalTranscript: string,
  priorTranscripts: string[],
): DetectedPronunciationError[];
```

- Tokenizes `finalTranscript` and each of `priorTranscripts` using the same word-splitter `g2p()`
  uses, so `wordIndex` values line up with canonical phones computed elsewhere in the pipeline.
- Skips any prior transcript whose word count doesn't match the final transcript's.
- For matching-length priors, compares word-by-word; for each differing position, runs both words
  through `g2p`'s CMUdict lookup and computes ARPAbet phone edit distance.
- Starting cutoff (first guess, expected to be revised against real session data per Non-goals):
  the two words' phone sequences must be the same length and differ in exactly one phone position
  (a single substitution — the "berry"/"very," "liberry"/"library" shape). Anything else — different
  phone counts, more than one differing position — is discarded as unrelated ASR noise, not a
  pronunciation cue.
- Multiple prior transcripts flagging the same word position dedupe to a single
  `DetectedPronunciationError`.
- Emits `{ word, op: "sub", expectedPhoneme, spokenPhoneme, source: "transcript_revision" }`
  per surviving position.

## Data model

`packages/types/src/index.ts` — extend the existing pronunciation-error shapes (not a new,
parallel type) with a `source` field:

```ts
export const PRONUNCIATION_ERROR_SOURCES = ["audio", "transcript_revision"] as const;
export type PronunciationErrorSource = (typeof PRONUNCIATION_ERROR_SOURCES)[number];

export interface DetectedPronunciationError {
  word: string;
  op: PronunciationEditOp;
  expectedPhoneme: string;
  spokenPhoneme: string | null;
  source: PronunciationErrorSource;
}

export interface PersistedPronunciationError extends DetectedPronunciationError {
  id: string;
}
```

`apps/server/src/db/schema.ts` — new `pronunciation_error_source` pgEnum and `source` column on
`turnPronunciationErrors`, via a new drizzle migration (applied to `kalli_dev` and `kalli_test`,
matching the existing table's own migration precedent). `"audio"` isn't produced by anything today
(HuPER doesn't exist yet) but the column exists now so there's no second migration once it does.

`apps/server/src/llm.ts` — the pronunciation-error prompt-building step branches phrasing on
`source`: tentative framing ("it sounded like you may have said X instead of Y") for
`transcript_revision`, direct framing for `audio` (a dormant branch until HuPER ships).

`turn_pronunciation_errors` WS message — carries `source` per error, for the (not-yet-built)
correction panel to show provenance.

## Testing

- `pronunciationRevisionDetector.test.ts` (pure unit tests, no I/O):
  - The repro case — prior `"I had a berry good day"`, final `"I had a very good day"` — produces
    exactly one `transcript_revision` deviation at the correct word index with the correct
    expected/spoken phonemes.
  - A prior transcript with a different word count than the final one is skipped entirely.
  - A revision with a large phone edit distance (unrelated word substitution) produces no
    deviation.
  - Multiple prior transcripts that all flag the same word position dedupe to one error.
  - No revisions across any prior transcript returns `[]`.
- `session.ts`: extend the existing two-pass pipeline tests —
  - `turnTranscriptHistory` accumulates across `Update`/`EagerEndOfTurn`/`TurnResumed` events and
    resets at `StartOfTurn` and after `EndOfTurn`.
  - A detected revision-based error merges into the same `pronunciationErrors` list a (faked)
    HuPER result would populate, reaches `generateReply`, and persists/sends over WS the same way
    an audio-sourced error would once HuPER exists.
