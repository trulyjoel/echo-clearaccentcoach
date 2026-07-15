# 07 — Two-pass correction pipeline

**What to build:** Turn processing splits into an analysis pass and a reply pass. The analysis pass produces a structured error list (category, original text, corrected text, explanation) using a generic taxonomy (word order, verb tense/aspect, subject-verb agreement, article usage, preposition choice) — no L1-specific hints yet. The reply pass weaves a brief spoken correction into Callie's conversational reply.

**Blocked by:** 05 — Turn-based conversational reply loop

**Status:** ready-for-agent

- [ ] Pass 1 takes the turn's transcript and produces a structured error list tagged by category, with original text, corrected text, and a brief explanation per error
- [ ] Pass 1 covers the five generic categories: word order, verb tense/aspect, subject-verb agreement, article usage, preposition choice
- [ ] Pass 2 takes the transcript, the pass-1 error list, and recent conversation history, and produces a reply that briefly and naturally corrects the most relevant error without derailing the conversation
- [ ] Turns with no detected errors produce a reply with no correction woven in
- [ ] Error rows are persisted per turn, linked to the Turn record, with category/original/corrected/explanation fields
- [ ] Both passes go through the swappable LLM abstraction from ticket 05
