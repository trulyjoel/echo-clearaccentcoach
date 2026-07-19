# 02 — Conversation thread as speech bubbles

**What to build:** The Session screen's transcript and reply display become a scrolling thread of
speech bubbles reflecting the full session history, not just the current turn. Callie's turns
render left-aligned, the user's right-aligned, in the violet/lavender palette from ticket 01, with
the user's still-being-spoken words visible as a live-updating draft bubble.

**Blocked by:** 01 — Tailwind CSS styling foundation

**Status:** ready-for-agent

- [ ] Every user and Callie turn from the session remains visible and scrollable in the thread, in
      order — not overwritten as new turns arrive.
- [ ] The user's in-progress (not-yet-finalized) speech appears as a live-updating bubble that
      locks in once the turn finalizes.
- [ ] User turns render right-aligned in a filled violet bubble; Callie's turns render
      left-aligned in a neutral/lavender-tinted bubble.
- [ ] The thread auto-scrolls to show the newest turn as the conversation progresses.
- [ ] The thread is exposed as a live region so a screen reader announces new/updated turns.
- [ ] Detected errors arriving via `turn_errors` correctly attach to the user turn they belong to,
      by attaching to the currently-open user turn — no WebSocket protocol change required (an
      interrupted turn is guaranteed to never emit `turn_errors`, so whichever user turn is
      currently open is unambiguous).
- [ ] Existing Session-level tests (rendered through the existing WebSocket-driven seam) are
      updated to assert on the new bubble-based rendering.
- [ ] New isolated component tests cover the conversation-thread/bubble rendering directly (given
      turn data as props), independent of the full WebSocket flow.

## Comments
