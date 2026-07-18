# 06 — Barge-in support

**What to build:** A user can start speaking while Callie's reply is still playing. The backend detects this, cuts the TTS playback, and starts processing the user's new turn immediately, so the conversation feels natural rather than rigidly turn-locked.

**Blocked by:** 05 — Turn-based conversational reply loop

**Status:** ready-for-human

- [x] Mic stays open and streaming during Callie's TTS playback (not just during user turns)
- [x] Backend detects user speech starting while a reply is being streamed/played
- [x] On detected barge-in, the in-flight TTS stream to the client is stopped
- [x] The user's new speech is processed as the start of a new turn, without requiring the previous reply to finish
- [x] Barge-in does not corrupt or duplicate Turn records for the interrupted reply

## Comments

The mic/forwarding side of this (checkbox 1) already existed from ticket 04/05: the client's
`MediaRecorder` is only stopped in `cleanupMedia` (session end), never between turns, and the
server's binary-frame handler forwards to Deepgram unconditionally, regardless of whether a
reply is in flight. The actual gap was detection and interruption.

**Detection:** `apps/server/src/deepgram.ts` now passes `vad_events: "true"` to Deepgram's
`connect()`, which makes it emit a `SpeechStarted` message the instant it detects the user
talking — independent of any transcript result, so it fires immediately rather than waiting for
a final transcript. `DeepgramMessage` already had a `SpeechStarted` variant modeled (unused
until now), so no type changes were needed there.

**Interruption:** `apps/server/src/routes/session.ts` replaces the old `turnInProgress` boolean
(ticket 05's overlap guard) with an `activeTurn: { interrupted: boolean } | null` reference.
`handleTurn` checks `activeTurn.interrupted` at each await boundary (after the LLM call, after
persisting the Turn, and on each TTS chunk) and returns early once set, matching the existing
`ended` guard pattern. On a Deepgram `SpeechStarted` while a turn is active, the handler marks
`interrupted = true`, sets `activeTurn = null`, and sends a new `reply_interrupted` message —
nulling it immediately (rather than waiting for the interrupted `handleTurn`'s own cleanup) is
what lets the barge-in speech's own turn start right away instead of being dropped by the
overlap guard. `handleTurn`'s `finally` block only clears `activeTurn` if it still points at
*its own* turn object, so the stale call's cleanup can't clobber a newer turn that started in
the meantime — this was the main race to get right (see `session.test.ts`'s "processes the
barge-in speech as a new turn without waiting for the interrupted reply").

Turn persistence (checkbox 5): a Turn is only ever inserted after `db.insert(turns)` completes,
and that's gated by the same `interrupted` check — so a reply interrupted before persistence
(e.g. mid-LLM-call) simply never gets a row, and a reply interrupted after persistence (mid-TTS)
leaves its already-written row untouched, just without the trailing audio/`reply_audio_end`. No
existing row is ever mutated or deleted, so there's nothing to duplicate or corrupt.

The old "ignores an overlapping turn" test (no `SpeechStarted` in between two `speech_final`s)
is kept as a fallback-safety-net case, renamed to clarify it's distinct from real barge-in. A
second Turn-record test covers the mid-TTS case specifically (interrupted *after* persistence
leaves the row untouched, no duplicate insert), added after `/code-review`'s Spec pass flagged
that only the before-persistence case had a dedicated test.

**Client:** `apps/web/src/Session.tsx` now tracks the currently-playing reply `Audio` in a ref
and handles a new `reply_interrupted` message by pausing it and clearing the buffered-chunks
ref (covers both an already-playing reply and one still mid-stream, before its `Audio` element
even exists).

**Fixed unrelated stray WIP:** found uncommitted, failing changes to `app.ts`/`app.test.ts` from
before this session (moving `clerkPlugin` to the `onRequest` hook so it runs ahead of
`preValidation`) — committed separately (see git log) after tracking down why the new test
still failed: `@fastify/websocket`'s `injectWS()` test helper hardcodes `sec-websocket-version`
as a JS number, which crashes Clerk's header parsing (real wire traffic always sends it as a
string, so this never happens in production) — worked around by asserting through a plain
`app.inject()` instead, which runs the identical hook pipeline without going through the
WS-upgrade simulation. Also had to add dummy `CLERK_PUBLISHABLE_KEY`/`CLERK_SECRET_KEY` to
`.env.test` (documented in the README) since that test exercises the real `clerkPlugin` rather
than mocking it away.

Status set to `ready-for-human` rather than `ready-for-agent`: same reasoning as tickets 04/05 —
`DEEPGRAM_API_KEY` isn't provisioned in this environment, so the `vad_events`/`SpeechStarted`
wiring is verified against the fake Deepgram connection in tests only, not real Deepgram VAD
behavior.
