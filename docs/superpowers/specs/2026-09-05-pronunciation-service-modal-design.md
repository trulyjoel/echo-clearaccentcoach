# Pronunciation-scoring service (Modal, Python)

## Problem

`docs/superpowers/specs/2026-09-04-pronunciation-correction-design.md` designed phoneme-level
mispronunciation detection end-to-end, and its TypeScript half is built: `apps/server/src/g2p.ts`,
`apps/server/src/pronunciation.ts` (an `HttpPronunciationProvider` that POSTs a turn's audio to
`PRONUNCIATION_SERVICE_URL`), the `turn_pronunciation_errors` table, and the pipeline/prompt/WS
wiring in `session.ts`/`llm.ts` are all committed. `PRONUNCIATION_SERVICE_URL` points nowhere —
there is no service. The TS plan's scope note is explicit that building it is "a separate follow-on
plan"; this is that plan's design.

## Goals

- Build `apps/pronunciation-service/`: a Modal-hosted, Python service running HuPER
  (`huper29/huper_recognizer` + `huper29/huper_corrector`) that satisfies the HTTP contract already
  fixed by the shipped TS adapter — `POST /score`, multipart (`audio`, `canonical_phones`) in,
  `{"editOps": [...]}` out.
- Close one real gap the original design left unresolved: an inserted phone (`op: "ins"`) has no
  canonical phone to report as `expectedPhoneme`, but that field is currently typed/stored as
  non-nullable `string`. Resolved here as a small, in-scope TS-side follow-up (see "TS-side
  follow-up" below) rather than an undocumented sentinel value, since nothing is deployed yet.
- Keep the service's internal logic (audio decode → inference → wire-format mapping) unit-testable
  without needing a GPU or the real HuPER checkpoints in CI.

## Non-goals

- Renegotiating the HTTP contract itself (request/response shape, field names, endpoint path) — that
  was already fixed by the shipped TS side and its tests; this plan builds against it as a
  constraint.
- Modal's GPU memory-snapshotting feature. The original spec's cost math assumed ~5s
  memory-snapshot cold starts, but that feature is still maturing (region/GPU-type constraints) —
  deferred; v1 ships with plain cold starts, and real cold-start numbers get measured once deployed.
- A real-model integration test in CI (loading actual HuPER checkpoints on every run). One
  hand-run/manually-triggered slow test is future work if integration drift becomes a real problem;
  not built here.
- Retry logic inside the Modal service. A failed request just fails; the TS side already degrades
  to an empty pronunciation-error list on any `scoreTurn` failure (`session.ts`'s
  `Promise.allSettled` handling) — retrying here would duplicate resilience that already exists one
  layer up.
- CI/CD automation for `modal deploy`. Deploys are a manual, documented step, matching that neither
  app in this repo auto-deploys today.

## Architecture

```
apps/pronunciation-service/
├── modal_app.py       # Modal app: image build, GPU config, secret, ASGI mount for /score
├── models.py          # HuperModels: loads Recognizer + Corrector once per container
├── pipeline.py         # pure functions: decode_audio, run_recognizer, run_corrector, to_edit_ops
├── schemas.py          # pydantic request/response models matching the fixed wire contract
├── tests/
│   ├── test_pipeline.py # pytest: decode_audio for real, to_edit_ops against fake phone-op sequences
│   └── test_schemas.py  # pytest: request validation and auth-failure paths
├── pyproject.toml       # uv-managed deps; ruff/ty config
└── README.md            # deploy instructions, secret provisioning
```

Tests live under `tests/`, mirroring the package structure (the global Python convention), not
colocated — the colocated `*.test.ts` pattern is TS-specific and doesn't apply here.

`pipeline.py` has no Modal imports and no I/O beyond what's passed into its functions — it takes
bytes/arrays/plain data structures and returns them, the same pure/adapter split already used on the
TS side (`g2p.ts` is pure; `pronunciation.ts` is the vendor-call adapter). `modal_app.py` is the
thin layer: builds the image, loads models once via `@modal.enter()`, and exposes a FastAPI route
under `@modal.asgi_app()` that does auth-check → parse → call into `pipeline.py` → map result to
JSON, with no branching logic of its own beyond that.

## Model loading and inference pipeline

`models.py`'s `HuperModels` holds both loaded models (Recognizer, Corrector), loaded once at
container start and kept in GPU memory for the container's lifetime. Compute is a T4 GPU (per the
original spec's cost model), `min_containers=0` so it scales to zero between sessions — preserved
from the original spec's Fly-vs-Modal cost comparison. Checkpoints are downloaded from Hugging Face
and baked into the container image at build time (not fetched at cold-start, and not using Modal's
newer weight-snapshotting support) — slower deploys, predictable/simple cold starts, no runtime
dependency on Hugging Face being reachable.

`pipeline.py`, in call order:

1. `decode_audio(webm_bytes: bytes) -> np.ndarray` — pipes the bytes through an `ffmpeg` subprocess
   (installed in the image via `apt_install`) to produce 16kHz mono float32 PCM. `ffmpeg` over a
   Python decoding library: it's what actually needs to handle whatever WebM/Opus quirks Deepgram's
   recorder produces, and is trivial to reproduce/debug by running the same command locally.
2. `run_recognizer(models, pcm) -> AudioTokens` — WavLM-Large CTC forward pass.
3. `run_corrector(models, audio_tokens, canonical_phones: list[CanonicalWord]) -> list[PhoneEditOp]`
   — per-phone `KEEP`/`DEL`/`SUB`/`INS` ops against the canonical sequence, per
   `huper29/huper_corrector`'s existing interface.
4. `to_edit_ops(phone_ops, canonical_phones) -> list[PronunciationEditOp]` — collapses phone-level
   ops to the wire format. Every non-`KEEP` phone becomes one entry (`word`, `wordIndex` of the
   canonical word it falls under, `op`, `expectedPhoneme`, `spokenPhoneme`); a word with two
   deviating phones produces two entries sharing the same `word`/`wordIndex` — the TS side already
   handles this (`toDetectedPronunciationErrors` in `session.ts` maps the array 1:1, no
   dedup-by-word assumed). An `INS` op — a phone produced with no canonical counterpart — is
   attributed to the nearest canonical word (the preceding word, or the first word for a leading
   insertion) with `expectedPhoneme: null` (see "TS-side follow-up").

## Request handling, auth, and error responses

`schemas.py` defines the request (multipart: `audio: UploadFile`; `canonical_phones: str`,
JSON-parsed into a list of `CanonicalWord { word: str, phones: list[str] }` matching the TS shape
exactly) and the response (`{"editOps": [PronunciationEditOp]}`, both `expectedPhoneme` and
`spokenPhoneme` typed `str | None`).

The `/score` route:
- Checks a bearer token from the `Authorization` header against a Modal `Secret`
  (`pronunciation-service-auth`), constant-time comparison → `401` on mismatch.
- Validates the multipart body against `schemas.py` → FastAPI's default `422` on violation.
- Runs the pipeline; on any exception (corrupt audio, inference error), logs it and returns `503`
  with a short text body — matching what `HttpPronunciationProvider` already expects ("non-2xx
  status + text body") so the TS side's existing degrade-to-empty-list behavior keeps working
  unchanged, with no TS-side error-handling changes needed.

## Deployment, secrets, and tooling

- **Secrets:** one Modal `Secret` holding the shared bearer token; the same value is set as
  `PRONUNCIATION_SERVICE_TOKEN` in Fly's env for `apps/server` (manual `fly secrets set`, documented
  in the README — matching how other vendor keys are already provisioned there, no new automation).
- **Deploy:** `modal deploy modal_app.py` from `apps/pronunciation-service/`; the resulting URL
  becomes `PRONUNCIATION_SERVICE_URL` on the Fly side.
- **Tooling:** `uv` for deps/venv, `ruff check`/`ruff format`, `ty check`, `pytest` — applied here
  since the original spec explicitly left this repo's Python convention undecided ("no existing
  prior art to match").

## TS-side follow-up (in scope for this plan)

Small, contained changes to make `expectedPhoneme` nullable, symmetric with `spokenPhoneme`'s
existing `| null` (which already means "no phone here" for a deletion):

- `packages/types/src/index.ts`: `DetectedPronunciationError.expectedPhoneme: string` →
  `string | null`.
- `apps/server/src/db/schema.ts`: `turnPronunciationErrors.expectedPhoneme` drops `.notNull()`; new
  Drizzle migration, applied to `kalli_dev` and `kalli_test`.
- `apps/server/src/pronunciation.ts`: `editOpSchema`'s `expectedPhoneme: z.string().max(50)` →
  `.nullable()`.
- `apps/server/src/llm.ts`: `buildPronunciationErrorContext` currently interpolates
  `` `expected /${error.expectedPhoneme}/, said /${spoken}/` `` unconditionally. Extend it to render
  `expectedPhoneme === null` as "expected nothing here" (mirroring the existing `spoken ?? "(nothing)"`
  handling), so an insertion reads naturally in the prompt instead of literally as "expected /null/".
- `apps/server/src/pronunciation.test.ts`: add a case covering a `null` `expectedPhoneme` round-trip.
- `apps/server/src/llm.test.ts` (or wherever `buildPronunciationErrorContext` is currently tested):
  add a case for the insertion-phrasing branch.

No change needed to `toDetectedPronunciationErrors` in `session.ts` — it already passes
`expectedPhoneme` through untouched (`.map(({ word, op, expectedPhoneme, spokenPhoneme }) => ...)`),
so widening the type is all that's required there.

## Testing

- `tests/test_pipeline.py`: `decode_audio` tested for real against a small fixture WebM clip (ffmpeg
  isn't a model — deterministic and cheap enough to exercise directly, not worth mocking).
  `to_edit_ops` tested against hand-built fake `PhoneEditOp` sequences covering: a clean `SUB`, a
  `DEL` (null `spokenPhoneme`), a leading `INS` (attributed to the first word, null
  `expectedPhoneme`), and two deviations landing on the same word (two entries, same `wordIndex`).
  `run_recognizer`/`run_corrector` get a thin call-through test only — there's nothing but a model
  call to exercise until a real-model integration test exists (deferred, see Non-goals).
- `tests/test_schemas.py`: malformed `canonical_phones` JSON, missing audio part, wrong/missing auth
  token → expected `4xx`/`401`. Nothing here touches Modal's decorators or deploys anything;
  everything runs as plain pytest against `pipeline.py`/`schemas.py` directly.
- TS-side: see the specific test additions listed under "TS-side follow-up" above.

## Further notes

- Real per-request latency (recognizer + corrector + ffmpeg decode + HTTP overhead, on an actual
  cold and warm T4 container) hasn't been measured — the original spec's cost estimate padded 20x
  to absorb this uncertainty. Worth getting real numbers once this is deployed, before any actual
  cost commitment, per that spec's own "Further notes."
- If cold starts turn out to matter in practice (multi-second-plus, disrupting the live-conversation
  flow this feeds), revisit Modal's memory-snapshotting support then, once its GPU-shape constraints
  have had more time to mature.
