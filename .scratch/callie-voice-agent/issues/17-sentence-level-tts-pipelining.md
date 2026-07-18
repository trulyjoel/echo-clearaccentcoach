# 17 — Overlap reply generation and TTS via sentence-level pipelining

**What to build:** `generateReply` (pass 2) currently fully resolves before TTS synthesis starts at
all (`apps/server/src/routes/session.ts`'s `handleTurn`). Stream pass 2's text output and start TTS
on completed sentences as they arrive, instead of waiting for the full reply — overlapping two
currently-sequential pipeline stages. Biggest expected latency win of the three latency tickets, and
the most invasive: touches `llm.ts`, `tts.ts`, and the WS message flow. Only pays off once the
client can play audio chunks as they arrive (ticket 16) rather than buffering the full stream.

**Blocked by:** 07 — Two-pass correction pipeline, 16 — Progressive reply audio playback

**Status:** needs-triage

- [ ] `generateReply` uses the Vercel AI SDK's streaming text API instead of `generateText`
- [ ] Sentence boundaries are detected in the token stream reliably enough to hand off complete
      sentences to TTS
- [ ] TTS synthesis for sentence N can start while sentence N+1 is still being generated
- [ ] The full reply text (for `reply_text` and Turn persistence) is still assembled and
      sent/persisted correctly once generation completes
- [ ] Turn persistence and error handling still function correctly with the pipelined flow (a
      mid-stream LLM or TTS failure doesn't leave a duplicate/partial turn)
