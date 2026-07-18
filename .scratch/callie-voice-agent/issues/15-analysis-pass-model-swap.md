# 15 — Lighter model for the analysis pass

**What to build:** `analyzeErrors` (pass 1) and `generateReply` (pass 2) currently share one model
via `getModelId()` (`apps/server/src/llm.ts`). Pass 1 is structured extraction (tag errors against
a fixed taxonomy) — a lighter task than pass 2's conversational reply generation, and a likely
source of the ~2.2s pass-1 latency measured in baseline testing. Give each pass its own
independently configurable model, and default pass 1 to a faster/cheaper model.

**Blocked by:** 07 — Two-pass correction pipeline

**Status:** needs-triage

- [ ] `analyzeErrors` and `generateReply` can be configured with independent model ids
- [ ] Pass 1's default model is chosen for speed (e.g. Claude Haiku) instead of sharing pass 2's model
- [ ] Both model ids remain overridable via env vars, matching the existing `LLM_MODEL` pattern
- [ ] Error-detection accuracy is spot-checked against the same test utterances used in ticket 07,
      to confirm the faster model doesn't regress quality unacceptably
