# 05 — Inline flagged-error indicator on user bubbles

**What to build:** A user's bubble shows a wavy underline directly on the exact word(s) an error
was flagged for, in addition to the existing corrections panel entry — clicking the underlined
span scrolls to and highlights that error's full detail in the panel.

**Blocked by:** 02 — Conversation thread as speech bubbles, 03 — Corrections panel & controls
restyle

**Status:** ready-for-agent

- [ ] A detected error whose flagged text appears verbatim in its turn's rendered text gets a
      wavy underline on that exact span.
- [ ] An error whose flagged text can't be found verbatim in the turn's text is simply not
      underlined inline, but remains fully visible in the corrections panel — no correction is
      ever silently lost.
- [ ] Multiple flagged spans within the same turn are underlined without overlapping each other.
- [ ] Hovering an underlined span surfaces the correction and explanation.
- [ ] Clicking an underlined span scrolls the corrections panel to that error's entry and briefly
      highlights it.
- [ ] New isolated component/unit tests cover the span-matching logic (found verbatim, not found,
      overlapping candidates) directly.

## Comments
