# 02 — Inline emphasis marker resolution

**What to build:** A way to turn Kalli's reply text — which may contain an inline marker around
one word she wants to emphasize — into two views: plain text (marker removed, exactly the word
itself) for anything the user sees or that gets remembered as conversation history, and a
speech-ready version (marker replaced by a short pause plus the strong-form respelling, when one
exists) for what actually gets spoken. Must handle the marker arriving in pieces, since Kalli's
reply streams in as it's generated, and must not lose any text if the reply ends mid-marker.

**Blocked by:** None — ticket 01 was superseded rather than built (see its Comments); this shipped
without it.

**Status:** ready-for-human

- [x] Reply text with no marker passes through unchanged in both the plain and speech-ready views.
- [x] A marked word is stripped to plain text in one view, and upper-cased (no pause markup, no
      respelling table — see Comments) in the other, for any word, not just a fixed set.
- [x] A marker that arrives split across multiple chunks of streamed text still resolves
      correctly once the closing half arrives.
- [x] If streaming ends before a marker is closed, the unclosed marker's text is preserved as
      plain text rather than silently lost.

## Comments

Implemented 2026-09-03 as `apps/server/src/emphasisMarkers.ts` (`createMarkerResolver`), diverging
from this ticket's original shape in two ways, both decided via the live listening comparison
recorded in this session:

- **No pause markup, no respelling table.** The provider changed from ElevenLabs to Inworld;
  capitalizing the marked word (e.g. "the" → "THE") on Inworld's full model read as clearly
  emphasized on its own, so the `<break time='0.3s'/>` + strong-form-respelling mechanism this
  ticket and the spec originally called for was dropped entirely — not just the respelling table
  (ticket 01), but the pause too. This also obsoletes ticket 04 (which existed only to guard the
  pause markup against `sanitizeForSpeech`'s quote-stripping).
- **`feed()` returns an ordered array of segments, not one aggregated `{plain, speechText}`
  result.** A correctness bug surfaced while wiring this into `session.ts` (ticket 05): a single
  delta can contain both a sentence boundary and a marker, and the caller needs to know which
  sentence boundaries fall before vs. after the marker to route only the right sentence to the
  higher-quality TTS tier (see ticket 06, new scope) — not just "did this delta contain a marker
  somewhere." Segments make that ordering explicit; each segment carries `emphasized: boolean`
  instead of the whole call carrying one `hadMarker` flag. Covered by
  `emphasisMarkers.test.ts`'s "puts a sentence boundary that lands before the marker in its own
  earlier segment" case, and by `session.test.ts`'s "routes only the sentence with an emphasis
  marker..." integration test, both of which fail against the earlier (call-level) design.

Status set to `ready-for-human` rather than done: the marker resolver itself is fully unit-tested
and the emphasis *mechanism* (capitalization on Inworld's full model) was verified by ear in this
session, but the live end-to-end path — a real Claude reply actually emitting a `«word»` marker
per the ticket 03 prompt instruction, in a real conversation — hasn't been manually observed yet.
