# Deepgram Flux: audio encoding requirements vs Nova-3

No existing research-note convention was found under `.scratch/kalli-voice-agent/` (only
`spec.md` and `issues/`) or in `docs/agents/`, so this file establishes one:
`.scratch/<feature-slug>/research/<topic>.md`.

## Answer

**No.** Migrating from Nova-3 (`/v1/listen`) to Flux (`/v2/listen`) does **not** require adding
a transcoding step. Flux supports the exact same containerized-with-auto-detection path this repo
already relies on: WebM/Opus sent with no `encoding`/`sample_rate` params. The current pipeline
(`MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" })` → raw chunks forwarded untouched
by the server) can be pointed at `/v2/listen` with a model-string/endpoint swap.

## Evidence

### 1. Flux's own migration guide states WebM/Opus is a supported containerized format

`https://developers.deepgram.com/docs/flux/nova-3-migration` ("Audio Format Requirements" table):

| Audio Type | Encoding | Container | `encoding` param | `sample_rate` param | Supported Sample Rates |
|---|---|---|---|---|---|
| Raw | `linear16`, `linear32`, `mulaw`, `alaw`, `opus`, `ogg-opus` | None | **Required** | **Required** | `8000`, `16000`, `24000`, `44100`, `48000` |
| Containerized | `linear16` | WAV | **Omit** | **Omit** | Auto-detected from container |
| Containerized | `opus` | Ogg | **Omit** | **Omit** | Auto-detected from container |
| Containerized | `opus` | **WebM** | **Omit** | **Omit** | Auto-detected from container |

Same "Audio Requirements" section also states: `Channels: Mono only` — this repo's audio
(`MediaRecorder` on a single mic input) is already mono, so no action needed there either.

### 2. Flux's quickstart repeats the identical table

`https://developers.deepgram.com/docs/flux/quickstart` ("Audio Format Requirements"), same four
rows verbatim, plus:

> **Chunk Size:** 80ms audio chunks strongly recommended for optimal model performance and latency.

The only difference from the migration page: for the *raw* row, `sample_rate` param is listed as
"**Required** (`16000` recommended)" — an added recommendation, not a change to the containerized
rows.

### 3. The general encoding reference page confirms this is Flux-specific, documented behavior (not just an example)

`https://developers.deepgram.com/docs/encoding`:

> Encoding is required when raw, headerless audio packets are sent to the streaming service. If
> containerized audio packets are sent to the streaming service, this feature should not be used.
>
> Flux supports `linear16`, `linear32`, `mulaw`, `alaw`, `opus`, and `ogg-opus` for
> non-containerized/raw audio. Flux also supports containerized formats: `linear16` in WAV
> containers, `opus` in Ogg containers, and `opus` in WebM containers (omit the `encoding`
> parameter for containerized audio).

This resolves the ambiguity flagged in the original question: the `encoding=linear16` string that
appears in the nova-3-migration page's example URLs
(`wss://api.deepgram.com/v2/listen?model=flux-general-en&sample_rate=16000&encoding=linear16&eot_threshold=0.8`)
is one example configuration (raw PCM), not a hard requirement — the same page's own table
lists WebM/Opus as a valid, auto-detected alternative.

## Answers to the four specific sub-questions

1. **What `encoding` values does `/v2/listen` accept?** Same raw set as Nova-3 for non-containerized
   audio: `linear16`, `linear32`, `mulaw`, `alaw`, `opus`, `ogg-opus`. (Nova-3/`/v1/listen` also
   accepts `flac`, `amr-nb`, `amr-wb`, `speex`, `g729` for raw audio per `/docs/encoding`; the Flux
   docs don't list these as supported, so that's a narrower raw-format set than Nova-3 — irrelevant
   here since we're not sending raw audio.)
2. **Does Flux support container auto-detection like Nova-3?** Yes — WAV/linear16, Ogg/opus, and
   WebM/opus are all documented containerized inputs where `encoding` and `sample_rate` are
   **omitted** and auto-detected from the container, mirroring Nova-3's behavior.
3. **If raw were used, what sample_rate/channels, and is transcoding guidance given?** Raw would
   require `encoding` + `sample_rate` (one of 8000/16000/24000/44100/48000, 16000 recommended) and
   mono channels. Not applicable here since containerized WebM/Opus is supported directly. Deepgram's
   docs don't give ffmpeg/Web-Audio-API transcoding guidance on any of the pages checked — moot,
   since no transcoding is needed.
4. **Other connect-time params affecting how bytes must be prepared?** `/v2/listen` requires
   `model=flux-general-en` (or `flux-general-multi` + `language_hint`) in place of `model=nova-3`,
   and adds turn-detection params (`eot_threshold`, `eager_eot_threshold`, `eot_timeout_ms`) — none
   of which affect audio framing. Both docs pages recommend **80ms audio chunks** for optimal
   performance/latency (not stated as a hard requirement, and not mentioned at all in Nova-3's
   docs) — worth checking against this repo's current `MediaRecorder` `timeslice` value when the
   migration is actually implemented, since MediaRecorder's chunk timing is not guaranteed to match
   any given interval precisely.

## What's confirmed vs. what still needs a live check

- **Confirmed from primary docs** (three independent pages, consistent): WebM/Opus containerized
  input works on `/v2/listen` with no `encoding`/`sample_rate` params, same as Nova-3's
  auto-detection.
- **Not verified by a live connection test**: whether Deepgram's WebM/Opus auto-detection on
  `/v2/listen` handles the specific fragmented/chunked WebM stream `MediaRecorder` produces (headers
  only in the first chunk, no container framing on subsequent chunks) as gracefully as `/v1/listen`
  currently does. The docs don't distinguish "complete WebM file" from "chunked/streamed WebM" as
  input shapes. Since Nova-3 already handles this repo's exact `MediaRecorder` output today and Flux
  documents the same container-detection mechanism, this is a reasonable inference, not a doc-cited
  guarantee — worth a smoke test against a real `/v2/listen` connection before considering the
  migration done.
- The `/reference/flux-listen-en` and `/reference/speech-to-text-api/listen-streaming` API-reference
  pages either 404'd or didn't return v2-specific parameter tables distinct from the narrative docs
  above; the narrative docs (`/docs/flux/*`, `/docs/encoding`) were the authoritative source here.

## Sources

- https://developers.deepgram.com/docs/flux/nova-3-migration
- https://developers.deepgram.com/docs/flux/quickstart
- https://developers.deepgram.com/docs/encoding
