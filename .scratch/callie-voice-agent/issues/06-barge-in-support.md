# 06 — Barge-in support

**What to build:** A user can start speaking while Callie's reply is still playing. The backend detects this, cuts the TTS playback, and starts processing the user's new turn immediately, so the conversation feels natural rather than rigidly turn-locked.

**Blocked by:** 05 — Turn-based conversational reply loop

**Status:** ready-for-agent

- [ ] Mic stays open and streaming during Callie's TTS playback (not just during user turns)
- [ ] Backend detects user speech starting while a reply is being streamed/played
- [ ] On detected barge-in, the in-flight TTS stream to the client is stopped
- [ ] The user's new speech is processed as the start of a new turn, without requiring the previous reply to finish
- [ ] Barge-in does not corrupt or duplicate Turn records for the interrupted reply
