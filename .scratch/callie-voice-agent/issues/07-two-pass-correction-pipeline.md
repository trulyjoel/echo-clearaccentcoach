# 07 — Two-pass correction pipeline

**What to build:** Turn processing splits into an analysis pass and a reply pass. The analysis pass produces a structured error list (category, original text, corrected text, explanation) using a generic taxonomy (word order, verb tense/aspect, subject-verb agreement, article usage, preposition choice) — no L1-specific hints yet. The reply pass weaves a brief spoken correction into Callie's conversational reply.

**Blocked by:** 05 — Turn-based conversational reply loop

**Status:** ready-for-human

- [x] Pass 1 takes the turn's transcript and produces a structured error list tagged by category, with original text, corrected text, and a brief explanation per error
- [x] Pass 1 covers the five generic categories: word order, verb tense/aspect, subject-verb agreement, article usage, preposition choice
- [x] Pass 2 takes the transcript, the pass-1 error list, and recent conversation history, and produces a reply that briefly and naturally corrects the most relevant error without derailing the conversation
- [x] Turns with no detected errors produce a reply with no correction woven in
- [x] Error rows are persisted per turn, linked to the Turn record, with category/original/corrected/explanation fields
- [x] Both passes go through the swappable LLM abstraction from ticket 05

## Comments

The five categories now live in `apps/server/src/errorTaxonomy.ts` (`ERROR_CATEGORIES` +
`DetectedError`), a small shared module with two consumers: `llm.ts` (prompt taxonomy + `zod`
schema) and `db/schema.ts` (the `error_category` pg enum) — kept separate from both so neither
depends on the other.

`LLMProvider` (`apps/server/src/llm.ts`) gained `analyzeErrors(transcript)`, backed by the Vercel
AI SDK's `generateObject` against a `zod` schema shaped exactly like `DetectedError[]`, wrapped in
`{ errors: [...] }` (the SDK's object-mode requires a top-level object, not a bare array). Pass 2's
`generateReply` now also takes the pass-1 error list; `buildReplySystemPrompt` appends the error
list to `CALLIE_SYSTEM_PROMPT` and asks the model to pick the single most relevant one and weave
it in briefly — or, if the list is empty, appends an explicit "no correction" instruction rather
than leaving it to chance. Choosing *which* error is most relevant is left to pass 2's judgment
(it sees the full list plus conversation context pass 1 doesn't have) rather than pass 1 ranking
them, matching the ticket's "pass 2 takes ... the pass-1 error list ... and produces a reply".

`apps/server/src/routes/session.ts`'s `handleTurn` now runs `analyzeErrors` before
`generateReply`, threading its result through. Persistence: the `turns` insert now uses
`.returning()` and both the turn and its errors are written inside one `db.transaction` (new —
the ticket 05 turn insert was a single statement with nothing to keep atomic; now a turn with
errors needs both writes to succeed together). An analysis failure is treated the same as an
existing reply-generation failure (generic "Could not generate a reply" error, session stays
alive, no Turn persisted) since both are LLM calls against the same provider and a failure in
either means no coherent turn to save.

New migration `apps/server/drizzle/0003_puzzling_morgan_stark.sql` adds the `error_category` enum
and `turn_errors` table (`id`, `turn_id` FK, `category`, `original`, `corrected`, `explanation`,
`created_at`), applied to both `callie_dev` and `callie_test`.

Testing: `session.test.ts`'s `llmTestState` fake gained `analyzeErrors` (default: no errors) and
`generateReply` now records the `errors` argument it was called with. New `"two-pass correction
pipeline"` describe block covers: pass 1's transcript reaching `analyzeErrors` and its output
reaching `generateReply`, error rows persisted linked to the right turn, no error rows and an
errors-array of `[]` passed to pass 2 when nothing's detected, and an analysis failure keeping the
session alive without persisting a Turn (mirroring the existing reply-failure test).

Ran a throwaway script (not committed) against the real Anthropic API now that
`ANTHROPIC_API_KEY` is provisioned locally: `analyzeErrors("Yesterday I go to the store and I buy
a apple")` correctly tagged two `verb_tense_aspect` errors and one `article_usage` error with
sensible corrections/explanations; the following `generateReply` wove a natural, brief correction
into a conversational reply without listing every error; a grammatically clean sentence produced
an empty error list and a plain follow-up reply with no correction. Both passes verified against
the real provider, not just the fake.

Status set to `ready-for-human` rather than `ready-for-agent`: the correction pipeline's *quality*
(is the analysis accurate enough, is the woven-in correction actually natural-sounding across a
range of real learner speech) needs human judgment beyond what an automated real-API smoke check
can confirm — same reasoning as tickets 04–06 for their respective unverifiable-by-agent gaps.
