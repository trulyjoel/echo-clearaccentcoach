# 16 — Progressive reply audio playback on the client

**What to build:** The client currently buffers the entire TTS stream into one Blob before playing
anything (`apps/web/src/Session.tsx`, a deliberate simplification from ticket 05). That adds dead
time on top of whatever the server pipeline takes, even after the server has already finished
synthesizing audio. Switch to playing audio as chunks arrive instead of waiting for
`reply_audio_end` — a client-only change that doesn't touch the server pipeline.

**Blocked by:** 05 — Turn-based conversational reply loop

**Status:** ready-for-human

- [x] Client begins audible playback from the first arriving audio chunk rather than waiting for
      `reply_audio_end`
- [x] Playback approach (Web Audio API buffer queue vs MediaSource Extensions) is chosen and
      justified
- [x] Barge-in (ticket 06) and `reply_interrupted` handling still work correctly against streaming
      playback
- [x] Existing autoplay-policy error handling (ticket 05) is preserved

## Comments

Chose **MediaSource Extensions** over a Web Audio API buffer queue. The server (`session.ts`)
forwards each `Uint8Array` yielded by the ElevenLabs stream straight to `socket.send()` — chunk
boundaries are whatever the underlying HTTP stream happened to deliver, not MP3-frame-aligned.
`AudioContext.decodeAudioData` needs each buffer passed to it to be an independently decodable
unit, so per-chunk decoding would require the client to reassemble frame-aligned units first (or
tolerate decode failures on a fair fraction of chunks). MSE's `SourceBuffer.appendBuffer` is built
for exactly this: appending arbitrary byte ranges of a single ongoing stream to a demuxer that
tracks its own parse state across calls. It also mirrors the existing `audio/mpeg` mimetype the
old full-Blob approach already used, so no server-side format change was needed (client-only, as
the ticket scoped it).

Implementation (`apps/web/src/Session.tsx`): `reply_text` now creates a `MediaSource` + `Audio`
element immediately and calls `audio.play()` right away — the element naturally waits for enough
buffered data once `sourceopen` fires and the first chunk lands, so playback starts as soon as
that first chunk is appended rather than after the full stream. Each binary WS message is
converted to an `ArrayBuffer` and appended through a small per-session promise chain
(`appendQueue`) that guarantees only one `appendBuffer` call is in flight at a time (a second call
while one is `updating` throws `InvalidStateError`) and waits on `sourceBufferReady` in case a
chunk arrives before `sourceopen` has fired. `reply_audio_end` calls `mediaSource.endOfStream()`
once the queue drains. `reply_interrupted` sets an `interrupted` flag on the session (not just
clearing the "current session" ref) so appends already queued when a barge-in happens stop short of
running, while a session that's merely superseded by the next turn's `reply_text` (not
interrupted) is still allowed to finish flushing its own tail chunks.

Testing: `Session.test.tsx` gained `FakeMediaSource`/`FakeSourceBuffer` doubles (jsdom has no real
`MediaSource`) and the reply-audio test block was rewritten around them — chunks appending before
`reply_audio_end` arrives, a chunk queued before `sourceopen` fires, barge-in mid-stream, a stray
chunk arriving after interruption, barge-in with no reply in progress, barge-in before any chunk
arrives, autoplay-rejection handling, and per-reply isolation across two consecutive replies.

`/code-review` (Standards + Spec sub-agents, diff against `HEAD` at 37806bc) caught a real bug
before this landed: `reply_audio_end`'s `endOfStream()` call checked `mediaSource.readyState`
synchronously instead of first awaiting `sourceBufferReady`, so for a reply with zero audio chunks
(or just unlucky timing — `sourceopen` fires as a separate task, after the queued microtask that
ran the check) it could silently skip `endOfStream()`, leaving the `"ended"` event — and thus
`reply_playback_ended` — never firing. Fixed by awaiting `sourceBufferReady` first; added a
regression test (`Session.test.tsx`, "still ends the stream once sourceopen fires late...") and
confirmed it fails against the pre-fix code and passes against the fix. Also added a try/catch
around `addSourceBuffer("audio/mpeg")` (an unsupported mimetype threw synchronously inside the
`sourceopen` listener, permanently hanging every queued append with no error surfaced) and made
`reply_interrupted` revoke the object URL immediately (it previously only happened in the `"ended"`
handler, which barge-in preempts, leaking a blob URL). Standards review also flagged
`handleServerMessage` exceeding the 100-line function limit and duplicated append-queue-chaining
logic; both fixed by extracting `createReplyAudioSession`/`appendReplyAudioChunk`/
`finishReplyAudioStream`/`enqueue` helpers.

Status set to `ready-for-human` rather than `ready-for-agent`/done: everything here is verified
against fakes standing in for `MediaSource`/`SourceBuffer`, since jsdom doesn't implement them.
Real-browser manual verification (does playback actually start early and sound gapless, does
Safari's MSE + `audio/mpeg` support hold up) needs a human with a browser and ears, same reasoning
as tickets 05/07/15.
