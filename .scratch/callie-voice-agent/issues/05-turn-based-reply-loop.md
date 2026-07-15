# 05 — Turn-based conversational reply loop

**What to build:** A real back-and-forth conversation with Callie. When the user finishes a turn, the backend generates a conversational reply (single LLM call, no correction logic yet), synthesizes it via ElevenLabs, streams the audio back, and it plays in the browser. No correction, no barge-in yet.

**Blocked by:** 04 — Voice session plumbing (mic → live transcript)

**Status:** ready-for-agent

- [ ] On end-of-turn, the backend sends the transcript to an LLM (via the Vercel AI SDK, configured for Claude Sonnet) and generates a conversational reply
- [ ] The LLM provider is called through a swappable abstraction, not a hardcoded provider SDK call
- [ ] The reply text is synthesized to audio via ElevenLabs (existing preset voice) and streamed back to the client over the WebSocket
- [ ] Client plays the streamed reply audio automatically
- [ ] User can complete multiple turns in a row and the conversation stays coherent (reply reflects recent conversation history)
- [ ] A Turn record is persisted per exchange, with the transcript and reply
