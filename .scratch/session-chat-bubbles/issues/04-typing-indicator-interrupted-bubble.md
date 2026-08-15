# 04 — Typing indicator & interrupted-reply bubble

**What to build:** Kalli's side of the conversation thread gets its own turn-status lifecycle: a
typing indicator appears the instant the user finishes speaking, and a reply cut short by
barge-in or a pipeline error stays visible in the thread (marked as cut off) instead of
disappearing as it does today.

**Blocked by:** 02 — Conversation thread as speech bubbles

**Status:** ready-for-agent

- [ ] An animated typing-indicator bubble appears in Kalli's position immediately when the user's
      turn ends, before any reply text has arrived.
- [ ] The typing indicator is replaced by the real reply content as soon as reply text starts
      streaming in.
- [ ] A reply interrupted by barge-in keeps whatever text had streamed so far, visibly marked as
      cut off, rather than being cleared (today's behavior).
- [ ] A reply interrupted by a pipeline error behaves the same way — partial text kept, marked as
      cut off — consistent with barge-in handling.
- [ ] Existing Session-level tests covering barge-in/interruption are updated to assert on the new
      bubble-based behavior.
- [ ] New isolated component tests cover each assistant-turn status (pending/streaming/final/
      interrupted) directly.

## Comments
