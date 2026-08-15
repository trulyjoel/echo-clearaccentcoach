# 05 — Wire word emphasis into the live reply/TTS pipeline

**What to build:** In an actual session, when Kalli's reply marks a word for emphasis, the
learner sees plain, marker-free text in the chat exactly as before, while the audio they hear gets
a deliberate pause (and, when applicable, the emphatic pronunciation) right on that word — and
nothing marker-related ever leaks into the stored conversation history or the saved turn record.

**Blocked by:** 02 — Inline emphasis marker resolution, 03 — Teach Kalli's reply prompt the
emphasis-marker convention

**Status:** ready-for-agent

- [ ] The text streamed to the client during a reply is always marker-free, even when the
      underlying reply contains an emphasis marker.
- [ ] The audio actually synthesized for a reply containing an emphasis marker includes the pause
      (and respelling, when one applies) at that word.
- [ ] The reply text saved to conversation history and persisted for the turn is marker-free.
- [ ] Existing reply/TTS behavior for turns with no emphasis marker is unchanged.

## Comments
