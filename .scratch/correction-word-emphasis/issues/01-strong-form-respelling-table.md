# 01 — Weak-to-strong-form respelling table

**What to build:** A lookup that gives the "strong form" (emphatic pronunciation) spelling for a
small set of easy-to-drop English function words (a, the, to), preserving whatever capitalization
the input word had.

**Blocked by:** None — can start immediately

**Status:** wontfix

- [ ] Looking up a known weak-form word (a, the, to) returns its strong-form respelling (ay, thee,
      too), case-insensitively.
- [ ] The returned respelling matches the input word's capitalization pattern (all-caps in →
      all-caps out, initial-capital in → initial-capital out, e.g. "The" → "Thee").
- [ ] Looking up a word not in the table returns nothing — no respelling is applied.

## Comments

Superseded 2026-09-03: the TTS provider changed from ElevenLabs to Inworld mid-design (see
`docs/adr` context in the spec's pivot note), and a live listening comparison across
capitalization, single-asterisk wrapping, inline IPA phonemes, and this respelling approach found
capitalized text (e.g. "the" → "THE") reads as clearly emphasized on Inworld's full model, with no
lookup table needed at all — upper-casing is a pure, general-purpose transform that works on any
word, not just the three in this table's original scope. `getStrongForm()` was never built;
ticket 02's resolver upper-cases the marked word directly instead. Closing as wontfix rather than
done, since the deliverable this ticket specified (a respelling table) was deliberately not
built — see ticket 02 for what replaced it.
