# 05 — Wire word emphasis into the live reply/TTS pipeline

**What to build:** In an actual session, when Kalli's reply marks a word for emphasis, the
learner sees plain, marker-free text in the chat exactly as before, while the audio they hear gets
a deliberate pause (and, when applicable, the emphatic pronunciation) right on that word — and
nothing marker-related ever leaks into the stored conversation history or the saved turn record.

**Blocked by:** 02 — Inline emphasis marker resolution, 03 — Teach Kalli's reply prompt the
emphasis-marker convention

**Status:** ready-for-human

- [x] The text streamed to the client during a reply is always marker-free, even when the
      underlying reply contains an emphasis marker.
- [x] The audio actually synthesized for a reply containing an emphasis marker includes the
      emphasis (upper-cased word, not a pause — see ticket 02's Comments) at that word.
- [x] The reply text saved to conversation history and persisted for the turn is marker-free.
- [x] Existing reply/TTS behavior for turns with no emphasis marker is unchanged.

## Comments

Implemented 2026-09-03 in `apps/server/src/routes/session.ts`'s `streamReplyWithPipelinedTTS`.
`createMarkerResolver()` is instantiated once per reply (mirrors `sentenceBuffer` being a fresh
local per turn). Per streamed delta, each resolved segment's `plain` feeds `replyText`/
`reply_text_delta` (client captions, persistence, conversation history), and `speechText` feeds
`sentenceBuffer`/`splitSentences` in place of the raw delta — same substitution point ticket 17
already established for raw deltas, not a new pipeline stage. A `sentenceHasEmphasis` flag, set
from `segment.emphasized` and reset after each sentence is queued, tracks which sentence currently
being accumulated should route to the high-quality TTS tier (see ticket 06 below — new scope this
ticket's original text didn't anticipate).

`AsyncQueue<string>` became `AsyncQueue<{ text: string; highQuality: boolean }>`; `consumeAudio`
calls `getTTSProvider({ highQuality })` per sentence instead of `getTTSProvider()`.

Existing-behavior guarantee (last AC) verified by the full pre-existing `session.test.ts` suite
passing unchanged (176 tests) — no turn without a marker sees any behavior change, since
`sentenceHasEmphasis` only ever becomes true via a resolved marker segment.

New test coverage: `session.test.ts`'s "word emphasis" describe block, including a case
specifically constructed to catch the segment-vs-delta bug described in ticket 02's Comments (a
sentence boundary before the marker, both in one delta) — confirmed to fail against the earlier,
call-level-flag design before the fix.

Status set to `ready-for-human` rather than done, same reasoning as ticket 02: unit- and
integration-tested against mocks, not yet observed end-to-end against a live Claude + Inworld
turn.
