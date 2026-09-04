# 04 — Confirm TTS text sanitization can't corrupt the emphasis pause

**What to build:** A regression check confirming that the existing TTS text cleanup (which strips
stray double-quote characters before audio is generated) can never corrupt the pause markup
ticket 02 injects, given that markup is written with single-quoted attributes specifically to
avoid this collision.

**Blocked by:** None — can start immediately

**Status:** wontfix

- [ ] Text containing both ordinary quoted prose and the pause markup, once run through the
      existing TTS text cleanup, keeps the pause markup fully intact and only strips the ordinary
      quote characters.

## Comments

Superseded 2026-09-03: the shipped emphasis mechanism (ticket 02) has no pause markup at all —
capitalizing the marked word turned out sufficient on Inworld's full model, so the
`<break time='0.3s'/>` this ticket exists to guard never got built. No quote-collision risk to
regression-test.
