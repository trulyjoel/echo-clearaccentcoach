# 16 — Progressive reply audio playback on the client

**What to build:** The client currently buffers the entire TTS stream into one Blob before playing
anything (`apps/web/src/Session.tsx`, a deliberate simplification from ticket 05). That adds dead
time on top of whatever the server pipeline takes, even after the server has already finished
synthesizing audio. Switch to playing audio as chunks arrive instead of waiting for
`reply_audio_end` — a client-only change that doesn't touch the server pipeline.

**Blocked by:** 05 — Turn-based conversational reply loop

**Status:** needs-triage

- [ ] Client begins audible playback from the first arriving audio chunk rather than waiting for
      `reply_audio_end`
- [ ] Playback approach (Web Audio API buffer queue vs MediaSource Extensions) is chosen and
      justified
- [ ] Barge-in (ticket 06) and `reply_interrupted` handling still work correctly against streaming
      playback
- [ ] Existing autoplay-policy error handling (ticket 05) is preserved
