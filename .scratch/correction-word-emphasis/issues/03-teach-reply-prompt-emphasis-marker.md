# 03 — Teach Callie's reply prompt the emphasis-marker convention

**What to build:** When Callie corrects a dropped short function word, she repeats the corrected
phrase naturally in context — not as a "the little word 'X'" aside naming the word in isolation —
and marks just that word for emphasis, using the marker convention ticket 02's resolver
understands.

**Blocked by:** None — can start immediately (the prompt only needs to emit the marker text
convention; it doesn't call ticket 02's code directly. Coordinate the exact marker characters with
ticket 02 before both are done.)

**Status:** ready-for-agent

- [ ] When an error is present, the reply prompt includes guidance and an example showing how to
      mark a short corrected word for emphasis within a natural, in-context phrase.
- [ ] The guidance explicitly steers away from naming the corrected word in isolation (e.g. "the
      little word 'the'"), since that reads as correcting to a different word rather than
      emphasizing this one.

## Comments
