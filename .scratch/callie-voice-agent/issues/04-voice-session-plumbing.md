# 04 — Voice session plumbing (mic → live transcript)

**What to build:** A user can start a session; their mic audio streams to the backend over WebSocket, the backend streams it to Deepgram, and the resulting live transcript appears in the UI. No reply and no correction yet — this proves the raw audio pipeline works end to end.

**Blocked by:** 03 — Onboarding: native language + recording consent

**Status:** ready-for-agent

- [ ] User can start a session from the authenticated home page, which opens a WebSocket connection to the backend
- [ ] Browser mic audio streams to the backend over the WebSocket connection in real time
- [ ] Backend streams received audio to Deepgram and receives transcript results back
- [ ] Live transcript text is sent to the client over the WebSocket and rendered in the UI as the user speaks
- [ ] End-of-turn (endpointing) is detected and signaled, even though nothing consumes it yet
- [ ] A Session record is created when the session starts and closed when it ends
- [ ] Session cannot start for a user without recorded consent (enforced server-side, per ticket 03)
