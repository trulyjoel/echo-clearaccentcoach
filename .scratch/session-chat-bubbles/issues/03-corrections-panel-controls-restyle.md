# 03 — Corrections panel & controls restyle

**What to build:** The existing corrections side panel and the session's buttons (start/stop, play
clip, play target, bookmark/un-bookmark) get the same Tailwind visual treatment as the new bubble
thread, so the whole Session screen reads as one coherent, finished product rather than bubbles
next to unstyled leftovers.

**Blocked by:** 01 — Tailwind CSS styling foundation

**Status:** ready-for-agent

- [ ] The corrections panel is restyled with Tailwind — no change to what information it shows or
      how it's structured.
- [ ] Session's buttons (start/stop session, play clip, play target, bookmark/un-bookmark) are
      restyled with Tailwind.
- [ ] All existing behavior (button actions, panel content, error/alert banners) is unchanged —
      this is a visual-only pass.
- [ ] Existing tests continue to pass unchanged in behavior (selectors by role/text still
      resolve).

## Comments
