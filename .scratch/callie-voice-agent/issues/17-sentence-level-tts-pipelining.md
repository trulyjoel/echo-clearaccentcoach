# 17 — Overlap reply generation and TTS via sentence-level pipelining

**What to build:** `generateReply` (pass 2) currently fully resolves before TTS synthesis starts at
all (`apps/server/src/routes/session.ts`'s `handleTurn`). Stream pass 2's text output and start TTS
on completed sentences as they arrive, instead of waiting for the full reply — overlapping two
currently-sequential pipeline stages. Biggest expected latency win of the three latency tickets, and
the most invasive: touches `llm.ts`, `tts.ts`, and the WS message flow. Only pays off once the
client can play audio chunks as they arrive (ticket 16) rather than buffering the full stream.

**Blocked by:** 07 — Two-pass correction pipeline, 16 — Progressive reply audio playback

**Status:** ready-for-human

- [x] `generateReply` uses `streamText` (Vercel AI SDK) instead of `generateText`, exposing deltas
      and final usage (`apps/server/src/llm.ts`)
- [x] Each text delta is forwarded to the client as a new `reply_text_delta` WS message, driving a
      live "typed" caption as Callie's reply is generated (expands the ticket's original scope —
      confirmed via grilling on 2026-07-18)
- [x] Deltas are also buffered server-side into a sentence accumulator (`sentenceSplitter.ts`); a
      sentence boundary is detected via regex against the buffer, or an end-of-stream flush for
      any remaining unterminated text — not a full NLP sentence-splitter library, since replies
      are short/conversational and occasional misfires are low-stakes
- [x] On each detected sentence boundary, `TTSProvider.synthesize()` is called for that sentence
      (via a small `AsyncQueue` bridging the two loops). TTS calls run strictly one at a time, in
      sentence order (sentence N+1's `synthesize()` call doesn't start until sentence N's audio has
      fully finished streaming to the client) — this still satisfies "TTS for N runs while N+1 is
      being generated" via overlap with the LLM's continued streaming, without needing to
      reorder/interleave audio from concurrent TTS calls
- [x] The client opens its `MediaSource` (ticket 16) on the first `reply_text_delta` of a turn,
      instead of on `reply_text` as today — no separate "audio session started" message needed
- [x] The full reply text (`reply_text`, unchanged shape) is sent, followed by turn persistence and
      `turn_errors`, as soon as *generation* completes — independent of whether that turn's audio
      has finished synthesizing/streaming/playing. This is what lets the "no duplicate/partial
      turn" requirement below hold: a reply already fully generated is valid and worth persisting
      even if its audio is later interrupted by barge-in or fails to synthesize.
- [x] A mid-stream failure sends `error` plus `reply_interrupted` with a new `reason: "error"`
      field (vs. `reason: "barge_in"` for the existing barge-in case) so the client can visually
      distinguish the two — see Comments for how the two failure kinds (generation vs. synthesis)
      differ in whether the turn still gets persisted.
- [x] Turn persistence and error handling still function correctly with the pipelined flow (a
      mid-stream LLM or TTS failure doesn't leave a duplicate/partial turn)

## Comments

Triaged 2026-07-18: moved `needs-triage` → `ready-for-agent` after grilling resolved three open
design questions the original ticket didn't cover — see the AC above for the resolved shape.
Redundancy check confirmed nothing in this ticket was implemented yet (`generateReply` still used
`generateText`, `TTSProvider.synthesize` took one complete string, `handleTurn` was strictly
sequential, no sentence-boundary helper existed).

Implemented 2026-07-19. New files: `sentenceSplitter.ts` (pure sentence-boundary extraction,
regex-based) and `asyncQueue.ts` (a small single-consumer FIFO used to bridge the text-stream loop,
which pushes completed sentences, and the TTS loop, which consumes them one at a time). `llm.ts`'s
`generateReply` is now synchronous (kicks off `streamText` immediately, matching the AI SDK's own
behavior) and returns `{ textStream, usage }` instead of `Promise<{ text, usage }>` — the interface
was renamed `ReplyStream`; there's no `text` field since every caller already accumulates the full
text from `textStream` itself.

`session.ts`'s `handleTurn` splits into `streamReplyWithPipelinedTTS` (runs generation and the
sentence-triggered TTS queue concurrently) plus the existing turn-persistence flow. The trickiest
part of this ticket, and the reason the "once generation completes" phrasing in the AC matters: an
early design gated turn persistence on *both* the text and audio sides finishing (via
`Promise.all`), which is simpler to reason about but broke an existing guarantee — ticket
06/16-era barge-in tests expect a turn interrupted mid-TTS-playback to still have been persisted,
since by definition the text was already fully generated well before the user started talking over
the audio. Fixed by decoupling: `streamReplyWithPipelinedTTS` resolves as soon as text generation
finishes, returning a `waitForAudio()` closure the caller awaits separately once it's already sent
`reply_text`. A `pendingAudio` safety net in `handleTurn`'s `finally` block still guarantees the
audio side is always awaited before `activeTurn` is released, even on an early return path that
never explicitly called `waitForAudio()` — otherwise a barge-in landing between text finishing and
`waitForAudio()` being called could let two turns' audio overlap on the wire.

This decoupling also means a TTS-only failure (text generation fully succeeded) still persists the
turn/sends `reply_text`/`turn_errors` as normal — only the audio side reports `error` +
`reply_interrupted(reason: "error")` afterward — whereas a text-generation failure abandons the
whole turn (no valid text to persist), matching the pre-existing "Failed to generate reply" case.

Analysis-pass usage recording deliberately stayed bundled with reply-pass usage in one `recordUsage`
call after the reply stream settles (matching the original code's single combined call), rather
than moving it right after `analyzeErrors` resolves — an earlier attempt at that "obviously more
correct" incidental fix introduced a real DB round-trip between `analyzeErrors` resolving and
`generateReply` being invoked, silently delaying pass 2's kickoff and breaking several tests' timing
assumptions about when `generateReply` gets called relative to `end_of_turn` being sent. Reverted;
out of scope for this ticket.

TTS calls are billed per-sentence (`elevenlabsCharacters`) rather than once for the full text, since
each sentence is now its own `synthesize()` call — the sum across sentences equals what the old
single call billed.

Testing: `sentenceSplitter.test.ts` and `asyncQueue.test.ts` cover the two new pure utilities in
isolation (including a verified mutation-testing pass on the sentence-boundary regex). `llm.test.ts`
gained a streaming-contract test. `session.test.ts`'s existing turn-based-reply-loop,
two-pass-correction-pipeline, correction-text-panel, and barge-in-support suites were updated for
the new message sequence (`reply_text_delta` before audio chunks before the final `reply_text`) and
the `reply_interrupted` reason field; no test coverage was removed. `Session.test.tsx` gained new
tests for live caption rendering, not opening a second audio session for a reply's second delta,
caption finalization on `reply_text`, a fresh caption/session starting for the next reply, and the
barge-in-vs-error caption-clearing distinction — plus a real client-side bug the new tests caught:
gating the new-audio-session decision on `!replyAudioRef.current` (rather than an explicit
"awaiting next reply" flag) failed to open a second reply's session, since the ref stays populated
after `reply_audio_end` while the previous reply is still audibly playing.

Status set to `ready-for-human` rather than done: real-browser manual verification (does audio
actually start audibly earlier than before ticket 17, do captions read smoothly, does the
barge-in/error visual distinction look right) needs a human with a browser and ears, same reasoning
as tickets 05/07/15/16.
