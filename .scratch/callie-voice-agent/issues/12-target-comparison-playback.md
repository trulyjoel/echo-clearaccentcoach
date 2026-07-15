# 12 — Target-comparison playback

**What to build:** A user opens a flagged error and hears their own stored clip plus a target-pronunciation version of the corrected text, synthesized on demand via ElevenLabs and not persisted.

**Blocked by:** 11 — Audio clip capture + storage

**Status:** ready-for-agent

- [ ] User can play back their own stored audio clip for a specific flagged error
- [ ] User can request a "target" version of the corrected text, synthesized via ElevenLabs at request time
- [ ] The synthesized target audio is streamed to the client and not written to storage
- [ ] Repeated requests for the same error's target audio each trigger a fresh synthesis (no caching requirement for this ticket)
