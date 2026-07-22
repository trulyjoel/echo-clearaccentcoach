# 02 — Inline emphasis marker resolution

**What to build:** A way to turn Callie's reply text — which may contain an inline marker around
one word she wants to emphasize — into two views: plain text (marker removed, exactly the word
itself) for anything the user sees or that gets remembered as conversation history, and a
speech-ready version (marker replaced by a short pause plus the strong-form respelling, when one
exists) for what actually gets spoken. Must handle the marker arriving in pieces, since Callie's
reply streams in as it's generated, and must not lose any text if the reply ends mid-marker.

**Blocked by:** 01 — Weak-to-strong-form respelling table

**Status:** ready-for-agent

- [ ] Reply text with no marker passes through unchanged in both the plain and speech-ready views.
- [ ] A marked word that has a strong form (e.g. "the") is stripped to plain text in one view, and
      replaced with a pause plus its strong-form respelling in the other.
- [ ] A marked word with no strong form still gets a pause in the speech-ready view, without any
      text substitution.
- [ ] A marker that arrives split across multiple chunks of streamed text still resolves
      correctly once the closing half arrives.
- [ ] If streaming ends before a marker is closed, the unclosed marker's text is preserved as
      plain text rather than silently lost.

## Comments
