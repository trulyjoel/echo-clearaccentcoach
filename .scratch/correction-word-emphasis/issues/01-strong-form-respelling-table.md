# 01 — Weak-to-strong-form respelling table

**What to build:** A lookup that gives the "strong form" (emphatic pronunciation) spelling for a
small set of easy-to-drop English function words (a, the, to), preserving whatever capitalization
the input word had.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] Looking up a known weak-form word (a, the, to) returns its strong-form respelling (ay, thee,
      too), case-insensitively.
- [ ] The returned respelling matches the input word's capitalization pattern (all-caps in →
      all-caps out, initial-capital in → initial-capital out, e.g. "The" → "Thee").
- [ ] Looking up a word not in the table returns nothing — no respelling is applied.

## Comments
