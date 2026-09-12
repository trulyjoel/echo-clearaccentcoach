# 18 — Turn audio buffer is a corrupt WebM after the first turn

**Bug, now confirmed higher-impact than first filed:** the same corrupt
per-turn WebM buffer breaks two independent consumers:

1. Clicking "Play my clip" on a flagged error fails in the browser with
   `NotSupportedError: Failed to load because no supported source was found`.
2. **Pronunciation scoring silently fails for every turn after the first** in
   a real session. The pronunciation-service's `ffmpeg -i pipe:0` rejects the
   same buffer outright — `ffmpeg decode failed: ... Invalid data found when
   processing input` (`apps/pronunciation-service/pipeline.py:152-159`) —
   which surfaces server-side only as a 503 from `/score`, caught and logged
   by `analyzeTurn`'s `Promise.allSettled` (`session.ts:132-172`) as "Failed
   to score pronunciation." The user never sees an error; the turn just gets
   zero pronunciation feedback.

(2) means real sessions currently can't exercise pronunciation scoring past a
session's first turn — worth prioritizing over (1) alone.

**Status:** resolved

## Root cause

`apps/server/src/routes/session.ts:862-941`. The client's `MediaRecorder`
emits one continuous WebM/Opus stream for the whole session. Only the very
first binary chunk carries the container header (EBML + Segment + Tracks);
every later chunk is a headerless fragment.

To make each turn's clip independently playable, the code caches that first
chunk as `webmHeaderChunk` and prepends it to every later turn's fragments
(`session.ts:894-897`) before handing the buffer to `storeTurnClip`
(`apps/server/src/audioClips.ts:19`).

Splicing an old header onto a later turn's Cluster fragments produces a
byte-valid-looking but semantically broken WebM file — the Segment/timecode
state in the cached header doesn't match the spliced-in clusters. Browsers
reject this at decode time rather than at fetch time, which is why nothing
shows up in server logs.

## Reproduction

1. Start a session, speak a turn with a flagged pronunciation/grammar error, wait for the *second* turn's error to be flagged (not the first — the first turn's clip may play fine since the pre-roll window can still contain the real header).
2. Open the corrections panel, click "Play my clip" on the second (or later) turn's error.
3. Observe `Session.tsx:134`'s `console.error("Failed to play audio", error)` logging `NotSupportedError`.

## Scope for a fix (not yet designed)

Proper per-turn WebM slicing needs either:
- a WebM/Matroska remuxer to rewrite Segment/Cluster timecodes relative to each new clip's own header, or
- switching to a per-turn `MediaRecorder` instance (or `requestData()` boundary) client-side so each turn's clip is a self-contained, independently-valid file from the start.

Predates the wav2vec2-cutover branch — introduced with the Flux migration
(`96fc215`) and the original clip feature (`c38b57c`). The pronunciation-
scoring failure mode is not a wav2vec2-specific regression (any recognizer
behind `/score` would hit the same ffmpeg decode failure on this buffer) —
confirmed by reproducing against the currently-deployed `kalli-pronunciation-
service` on 2026-09-12 during local wav2vec2-cutover testing.

## Comments

**Fixed:** chose the per-turn `MediaRecorder` approach. `Session.tsx` now restarts the
recorder (via a `startRecorder` helper) right after every `end_of_turn` message from the
server, so each turn's chunks come from one fresh recorder instance — header through last
fragment, contiguous. `session.ts` dropped the `webmHeaderChunk`/pre-roll splice entirely;
`turnAudioChunks` just accumulates every chunk since the last turn boundary and
`Buffer.concat`s them directly, no stitching needed.

Trade-off: each turn's clip now includes the natural pause before speech starts (previously
trimmed to an ~800ms pre-roll window) instead of a clipped, occasionally-corrupt buffer.
Accepted as worthwhile since it fixes playback and pronunciation scoring for every turn past
the first.
