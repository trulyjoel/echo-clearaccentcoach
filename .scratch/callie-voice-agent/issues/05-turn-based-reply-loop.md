# 05 — Turn-based conversational reply loop

**What to build:** A real back-and-forth conversation with Callie. When the user finishes a turn, the backend generates a conversational reply (single LLM call, no correction logic yet), synthesizes it via ElevenLabs, streams the audio back, and it plays in the browser. No correction, no barge-in yet.

**Blocked by:** 04 — Voice session plumbing (mic → live transcript)

**Status:** ready-for-human

- [x] On end-of-turn, the backend sends the transcript to an LLM (via the Vercel AI SDK, configured for Claude Sonnet) and generates a conversational reply
- [x] The LLM provider is called through a swappable abstraction, not a hardcoded provider SDK call
- [x] The reply text is synthesized to audio via ElevenLabs (existing preset voice) and streamed back to the client over the WebSocket
- [x] Client plays the streamed reply audio automatically
- [x] User can complete multiple turns in a row and the conversation stays coherent (reply reflects recent conversation history)
- [x] A Turn record is persisted per exchange, with the transcript and reply

## Comments

`apps/server/src/routes/session.ts` now consumes the `end_of_turn` signal from ticket 04 instead of
leaving it a no-op. Finalized transcript segments (`is_final: true` results) accumulate in
`turnTranscriptParts`; when Deepgram marks `speech_final`, they're joined into one turn transcript,
the accumulator resets, and `handleTurn()` runs the reply pipeline without blocking the Deepgram
message handler (fire-and-forget, matching the existing `void endSession(...)` pattern).

Two new vendor-adapter modules mirror `deepgram.ts`'s shape exactly (typed interface + lazy-singleton
`getClient()`/`getApiKey()` + a factory function callers depend on instead of the SDK directly):

- `apps/server/src/llm.ts` — `LLMProvider.generateReply(history)`, backed by `@ai-sdk/anthropic` +
  the Vercel AI SDK's `generateText`. Model ID is configurable via `LLM_MODEL` (defaults to
  `claude-sonnet-5`), satisfying "swappable ... without rewriting orchestration logic" for when
  ticket 07 reuses this for its second pass.
- `apps/server/src/tts.ts` — `TTSProvider.synthesize(text)`, backed by `@elevenlabs/elevenlabs-js`'s
  `textToSpeech.stream()`, returning the SDK's own `ReadableStream<Uint8Array>` as an async iterable.
  Voice ID defaults to ElevenLabs' "Rachel" premade voice, overridable via `ELEVENLABS_VOICE_ID`.

Reply delivery over the WebSocket mirrors how the client already streams mic audio *up*: `@callie/types`
gained `reply_text` (JSON, sent once the reply is generated) and `reply_audio_end` (JSON, sent once
streaming finishes); the audio itself is **not** part of the message union — it's raw binary frames
(`socket.send(Buffer.from(chunk))`) sent between those two JSON messages, one WS message per TTS chunk.
`apps/web/src/Session.tsx` mirrors this on receive: `ws.onmessage` now checks `event.data instanceof
Blob` to route to an audio-chunk buffer instead of `JSON.parse`; on `reply_audio_end` the buffered
chunks become one `Blob`, played via `new Audio(URL.createObjectURL(blob))` with the object URL revoked
on the `ended` event.

The turn's `ConversationMessage[]` history lives in-memory in the WS handler's closure (one array per
connection, not persisted) — a *copy* (`[...conversationHistory]`) is passed to `generateReply` rather
than the live array, since the array keeps mutating (assistant reply pushed, next turn's user message
pushed) after the call returns; passing the live reference doesn't affect the real Anthropic request
(already sent over the network by the time it mutates) but made the fake LLM's recorded call history
unreliable in tests, which is what surfaced it.

The `turns` table (`id`, `session_id` FK, `transcript`, `reply`, `created_at`) is new
(`apps/server/drizzle/0002_old_tomorrow_man.sql`), applied to both `callie_dev` and `callie_test`. A
Turn is persisted right after the LLM call succeeds — before TTS runs — since the transcript/reply pair
is complete at that point regardless of whether audio synthesis later fails.

Error handling: an LLM or TTS failure sends a generic `error` message (vendor details logged
server-side only, per the existing convention) but does **not** end the session — the user can keep
talking and the next turn can still succeed. This differs from a Deepgram error, which does end the
session, since a broken transcription pipeline can't produce any more turns at all.

Testing: `apps/server/src/routes/session.test.ts` gained `../llm.js`/`../tts.js` mocks (same
`vi.mock` + fake-implementing-the-interface pattern as the existing Deepgram fake) and a new
`turn-based reply loop` describe block — reply generation + audio streaming, Turn persistence,
multi-segment transcript concatenation, conversation history carried across turns, and both vendor
failure paths (session stays alive, Turn persisted or not depending on which pass failed). A `mixedQueue`
test helper extends the existing `messageQueue` to also buffer raw binary frames. `apps/web/src/Session.test.tsx`
gained a `FakeAudio` class and `URL.createObjectURL`/`revokeObjectURL` stubs to verify autoplay,
object-URL cleanup, and per-turn buffer reset.

Status set to `ready-for-human` rather than `ready-for-agent`, same reasoning as ticket 04:
`ANTHROPIC_API_KEY` and `ELEVENLABS_API_KEY` aren't provisioned in this environment (see
`apps/server/.env.example`), so the reply/TTS pipeline is verified against fakes only, not the real
vendor APIs — an agent can't do that verification pass without credentials.

**Update:** ran `/code-review` (Standards + Spec axes). Standards flagged an unguarded
`db.insert(turns)` that could become an unhandled rejection on a DB error, and an unguarded
`audio.play()` on the client that could do the same on an autoplay-policy rejection — both now
wrapped/caught. Spec flagged that `handleTurn` is fire-and-forget with no guard against overlap: if
the user starts speaking again while a reply is still being generated (the mic never closes, and
barge-in support is ticket 06, not this one), a second `speech_final` could trigger a second
`handleTurn` call that mutates the shared `conversationHistory` array out of order with the first.
Added a `turnInProgress` flag so an overlapping turn's reply pipeline is skipped (its transcript is
still sent to the client as a live transcript, just no reply is generated for it) — covered by a new
test that holds the first turn's LLM call open with a controllable promise and confirms
`generateReply` isn't called a second time until the first turn finishes. The other Spec note
(reply audio is buffered client-side and played once complete, rather than played progressively as
chunks stream in) was left as-is — it's a deliberate simplification: replies are a few seconds of
speech, and progressive playback would need the `MediaSource` API for real gain, which isn't
justified by the ticket's "plays automatically" requirement.
