# 10 — Session limits + usage metering

**What to build:** The server enforces a maximum session duration and a daily session cap per user before allowing a session to start, and records per-session vendor usage (STT minutes, TTS characters, LLM tokens in/out) for future billing/limit features.

**Blocked by:** 05 — Turn-based conversational reply loop

**Status:** ready-for-agent

- [ ] Server rejects starting a new session if the user has already hit their daily session-count cap
- [ ] An active session is automatically ended once it hits the maximum session duration
- [ ] Per-session usage is recorded: Deepgram minutes consumed, ElevenLabs characters synthesized, LLM input/output tokens for both pipeline passes
- [ ] Usage records persist even though no billing/payment enforcement exists yet
- [ ] Session-end reason (user-ended, hit max duration, disconnected) is recorded on the Session record
