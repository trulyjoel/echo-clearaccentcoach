# 03 — Teach Kalli's reply prompt the emphasis-marker convention

**What to build:** When Kalli corrects a dropped short function word, she repeats the corrected
phrase naturally in context — not as a "the little word 'X'" aside naming the word in isolation —
and marks just that word for emphasis, using the marker convention ticket 02's resolver
understands.

**Blocked by:** None — can start immediately (the prompt only needs to emit the marker text
convention; it doesn't call ticket 02's code directly. Coordinate the exact marker characters with
ticket 02 before both are done.)

**Status:** ready-for-human

- [x] When an error is present, the reply prompt includes guidance and an example showing how to
      mark a short corrected word for emphasis within a natural, in-context phrase.
- [x] The guidance explicitly steers away from naming the corrected word in isolation (e.g. "the
      little word 'the'"), since that reads as correcting to a different word rather than
      emphasizing this one.

## Comments

Implemented 2026-09-03: `EMPHASIS_INSTRUCTION` in `apps/server/src/llm.ts`, appended to
`REPLY_SYSTEM_PROMPT` after the existing error-correction examples. Marker characters (`«` `»`)
match ticket 02's resolver exactly, per this ticket's own coordination note. Covered by
`llm.test.ts`'s "instructs the model to mark short easy-to-miss words with «guillemets»".

Status set to `ready-for-human`: the prompt text itself is tested, but whether Claude actually
follows this instruction reliably in live conversation — marking at most one word, only when it
fits the short-word case — hasn't been observed against the real model yet.
