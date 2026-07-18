# 15 — Lighter model for the analysis pass

**What to build:** `analyzeErrors` (pass 1) and `generateReply` (pass 2) currently share one model
via `getModelId()` (`apps/server/src/llm.ts`). Pass 1 is structured extraction (tag errors against
a fixed taxonomy) — a lighter task than pass 2's conversational reply generation, and a likely
source of the ~2.2s pass-1 latency measured in baseline testing. Give each pass its own
independently configurable model, and default pass 1 to a faster/cheaper model.

**Blocked by:** 07 — Two-pass correction pipeline

**Status:** ready-for-human

- [x] `analyzeErrors` and `generateReply` can be configured with independent model ids
- [x] Pass 1's default model is chosen for speed (e.g. Claude Haiku) instead of sharing pass 2's model
- [x] Both model ids remain overridable via env vars, matching the existing `LLM_MODEL` pattern
- [x] Error-detection accuracy is spot-checked against the same test utterances used in ticket 07,
      to confirm the faster model doesn't regress quality unacceptably

## Comments

`getModelId` (`apps/server/src/llm.ts`) split into `getReplyModelId` (unchanged: `LLM_MODEL` env
var, defaults to `claude-sonnet-5`) and `getAnalysisModelId` (new: `ANALYSIS_LLM_MODEL` env var,
defaults to `claude-haiku-4-5-20251001`). Both are read at call-time inside `analyzeErrors` /
`generateReply` respectively, not baked into the memoized client/provider singletons, so per-call
overrides work correctly. `.env.example` documents the new var alongside the existing one.

Ran a throwaway script (not committed) against the real Anthropic API with the new Haiku default:
`analyzeErrors("Yesterday I go to the store and I buy a apple")` correctly tagged the same three
errors ticket 07's spot check found (two `verb_tense_aspect`, one `article_usage`) with sensible
corrections/explanations; the grammatically clean control sentence produced an empty error list,
same as ticket 07. Timing comparison on the same call: ~2.6s with the new Haiku default vs ~5.2s
forcing `ANALYSIS_LLM_MODEL=claude-sonnet-5` (the old shared default) — roughly halves pass-1
latency, consistent with this ticket's hypothesis.

Status set to `ready-for-human` rather than `ready-for-agent`/done: same reasoning as ticket 07 —
whether Haiku's error-detection quality holds up across a broader range of real learner speech
(not just the one ticket-07 utterance) needs human judgment beyond a single automated spot check.

Testing: `llm.test.ts` gained a "per-pass model selection" describe block, mocking `@ai-sdk/anthropic`
and `ai` at the module boundary to assert the exact model id passed to each pass — covers the
default split (Haiku vs `claude-sonnet-5`) and independent env-var overrides for both passes.
