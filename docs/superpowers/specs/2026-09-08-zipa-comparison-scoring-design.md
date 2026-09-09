# ZIPA-CR parallel comparison scoring (alongside HuPER-GOP)

## Problem

`2026-09-08-gop-pronunciation-scoring-design.md` replaced the HuPER Corrector with GOP scoring
against `huper29/huper_recognizer`, shipped it, and deployed it live. Testing the live service with
real audio (a native English speaker vs. a Spanish-accented speaker, word set "Rock/Red/Arrow/Try")
found a structural limitation, not a training gap: **the current backend cannot detect a trilled R
vs. the English approximant R, and no amount of retraining fixes it.** ARPAbet — the phone inventory
this whole pipeline is built on, from `g2p.ts` through the recognizer's own output vocabulary — has
exactly one symbol for R. English doesn't phonemically contrast trill/tap/approximant, so ARPAbet
collapses them all into one label; the output space itself has no slot for the distinction.

This matters beyond R: the user's actual goal, confirmed explicitly, is to stay in English as the
target language while detecting mispronunciations from learners across many different L1
backgrounds. Different L1s substitute different non-English allophones into English target phones
(Spanish trills, a Japanese tap-like liquid standing in for both R and L, French/German uvular R,
and so on) — ARPAbet's single-symbol-per-English-phoneme design makes *every one* of these invisible
to the current pipeline, not just the R case that happened to get tested first.

## Candidate selection

The first candidate considered, `xinjli/allosaurus` (ICASSP 2020), was rejected after checking its
actual maintenance signal, not just its reputation: Open Source Insights' scorecard shows **zero
commits and zero issue activity in the last 90 days**, one release ever (2021), last push April
2024, and it's GPL-3.0-licensed — a heavier copyleft obligation than anything else in this stack. A
single-author, dormant package is a poor foundation for a service meant to run indefinitely.

Surveying the actual current research line on this exact problem (universal/cross-lingual phone
recognition, standardized on a metric called PFER — phone-feature error rate, from PanPhon
articulatory features) surfaced better-fitting, actively-maintained options. Benchmarked against
each other in the ZIPA paper (ACL 2025, `lingjzhu/zipa`) and again in PhoneticXeus's paper
(Interspeech 2026), on the same held-out multilingual/accented-English evaluation:

| | Allosaurus | `wav2vec2-xlsr-53-espeak-cv-ft` | **ZIPA-CR** | PhoneticXeus |
|---|---|---|---|---|
| Published | 2020 | 2021 | 2025 | 2026 |
| Params | 11M | 300M | 64M (small) – 300M (large) | 0.6B |
| Multilingual PFER | worst of the four | middling | beats Allosaurus & wav2vec2-xlsr-53 with fewer params | best reported |
| Loading | bespoke `allosaurus` pip package, own serving code | `transformers.Wav2Vec2ForCTC` | ONNX Runtime, standalone script, no arbitrary code execution | `transformers.AutoModel(..., trust_remote_code=True)` |
| License | GPL-3.0 | Apache-2.0 | MIT | not yet checked |
| Maturity signal | dormant since 2024 | static checkpoint, fine | actively used, real GitHub history | created this year, 18 stars |

**Chosen: `ZIPA-CR-small`** (`anyspeech/zipa-small-crctc-500k` on Hugging Face). It's purpose-built
for this exact problem, beats both older candidates on the standard benchmark, is CTC-based (see
"Why CTC matters" below) so it plugs into the forced-alignment pipeline already built for HuPER, is
MIT-licensed, and its 64M-parameter size works in favor of the "scoring runs inline" decision below
rather than against it. PhoneticXeus reports better numbers, including a result specifically on
accented English, but was set aside for now: it requires `trust_remote_code=True` (executes the
model repo's own Python at load time — a real supply-chain trust decision, not just friction) and
is a month old at the time of this design. Worth revisiting once it's had more real-world vetting.

## Why CTC matters here

`HuperRecognizer` and `ZIPA-CR` are both CTC (Connectionist Temporal Classification) models: at
every audio frame they independently output a probability distribution over phones (plus a blank
token), with no built-in notion of phone boundaries. `torchaudio.functional.forced_align` takes that
raw `(frames × vocab)` matrix plus a known target phone sequence and finds the most probable
frame-by-frame path producing exactly those phones — which is how `_group_into_spans` gets per-phone
frame ranges and how GOP (canonical phone's probability vs. the best-scoring alternative) gets
computed. `ZIPA-T`, the family's transducer variant, doesn't expose that same per-frame matrix (its
predictions condition on its own prior outputs); it would need real extra work to fit this pipeline,
which is why `ZIPA-CR` (the CTC variant) is the one chosen, not a naming coincidence.

## Goals

- Run `ZIPA-CR-small` through the same GOP pipeline as HuPER, on the same audio, for every scored
  turn — as a **comparison signal to observe, not a replacement**. HuPER-GOP stays the thing that
  actually determines what the app shows a user.
- Keep `apps/pronunciation-service`'s HTTP contract, `schemas.py`, and every TS-side consumer
  (`apps/server/src/pronunciation.ts`, `g2p.ts`, `session.ts`) exactly as they are — this is a
  Python-service-internal addition only, same boundary the GOP migration itself preserved.
- Build the ARPAbet→ZIPA-IPA phone mapping, including a real answer for diphthongs (see "Diphthong
  handling" below) rather than a lossy shortcut.

## Non-goals

- **Serving ZIPA's result to the app, or persisting it anywhere durable.** Decided explicitly: log
  it, don't wire it. If the comparison data turns out to be worth querying later, that's a separate
  follow-up with its own design (a schema/store decision deserves its own scrutiny, not a rider on
  this one).
- **Deciding whether to eventually replace HuPER with ZIPA.** This design produces the data to make
  that call later; it doesn't make the call now.
- **Using the learner's L1 (already captured at onboarding) to bias scoring.** Worth revisiting once
  comparison data exists, not decided here.
- **Optimizing latency.** Scoring runs inline, doubling per-turn model-inference cost for the
  duration of the comparison period — an explicit, accepted trade for implementation simplicity over
  a fire-and-forget background path. `ZIPA-CR-small`'s 64M-parameter size keeps this trade cheaper
  than it would otherwise be. Revisit if real measured latency threatens `SCORE_TURN_TIMEOUT_MS`
  (`apps/server/src/pronunciation.ts`).
- **Re-evaluating PhoneticXeus.** Noted above as a stronger-benchmarked alternative set aside for
  `trust_remote_code` and maturity reasons — a candidate for later, not part of this design.

## Architecture

```
apps/pronunciation-service/
├── modal_app.py        # image gains ZIPA-CR's deps (onnxruntime + a small torch-free inference
│                        # path where possible) + a checkpoint download step; PronunciationService
│                        # .load() instantiates both recognizers
├── handler.py           # handle_score_request gains a second recognizer param; HuPER result is still
│                        # the only thing in ScoreResponse
├── models.py             # + ZipaRecognizer, alongside the existing HuperRecognizer
├── arpabet_to_ipa.py       # new: static phone-mapping table + to_zipa_phones()
├── pipeline.py              # unchanged — score_pronunciation is already model-agnostic
├── schemas.py                # unchanged
└── tests/
    ├── test_models.py          # + ZipaRecognizer coverage
    ├── test_arpabet_to_ipa.py   # new
    └── test_handler.py           # + case: ZIPA failure doesn't affect ScoreResponse
```

### `ZipaRecognizer` (`models.py`)

Satisfies the same `Recognizer` protocol `pipeline.py` already defines (`label2id`, `id2label`,
`log_probs(waveform)`), wrapping `ZIPA-CR-small`'s ONNX-exported checkpoint
(`anyspeech/zipa-small-crctc-500k`) via `onnxruntime` — chosen deliberately over ZIPA's full
`icefall`/`k2`/`lhotse` training-stack inference path specifically to keep the image's dependency
footprint small, in the same spirit as rejecting Allosaurus for its footprint. `label2id`/`id2label`
come from the model's own `tokens.txt` vocabulary. The exact ONNX Runtime session input/output tensor
shapes and `tokens.txt` parsing need to be confirmed against the actual exported artifact — see
"Deferred to implementation."

### Phone mapping (`arpabet_to_ipa.py`)

A static `ARPABET_TO_IPA: dict[str, tuple[str, ...]]` mapping each ARPAbet phone `pipeline.py` may
see (from `g2p.ts`'s output vocabulary) to one or more of ZIPA's IPA symbols, plus:

```python
def to_zipa_phones(canonical_phones: list[CanonicalWord]) -> list[CanonicalWord]:
    """Rewrites each word's ARPAbet phones into ZIPA's IPA symbols for comparison scoring."""
```

**Diphthong handling:** ARPAbet writes diphthongs (`AY`, `AW`, `EY`, `OW`, `OY`) as a single token;
IPA inventories (ZIPA's included) have separate symbols for the onset and offset vowel, no single
symbol for the diphthong as a unit. Decided: expand each diphthong into its two-phone IPA sequence at
mapping time, rather than collapsing to one approximate symbol — `score_pronunciation` already
handles a variable number of phones per word (it just repeats `(word, word_index)` per phone), so
this needs no changes there. The one real consequence: a single ARPAbet diphthong can now produce up
to two edit ops in ZIPA's output where HuPER's would produce (at most) one. Since this output is
logged, not served or counted, that's an acceptable asymmetry — not something a consumer needs to
reconcile.

### `handle_score_request` (`handler.py`)

Gains a `zipa_recognizer: Recognizer` parameter. After building the `ScoreResponse` from HuPER's
result exactly as today, it calls:

```python
try:
    zipa_ops = score_pronunciation(zipa_recognizer, waveform, to_zipa_phones(words))
    logger.info("zipa comparison: %s", zipa_ops)
except Exception:
    logger.exception("zipa comparison scoring failed")
```

before returning the (unchanged) `ScoreResponse`. This is the only place that catches broadly —
`score_pronunciation` and `ZipaRecognizer` themselves stay strict (raise on bad input, same contract
as the HuPER path), because a real, independently-correct function is what makes the comparison data
trustworthy. The swallowing happens at the call site because *that call's result* is diagnostic, not
because the function itself is allowed to be sloppy.

### `modal_app.py`

`PronunciationService.load()` (the existing `@modal.enter()` hook) instantiates both
`HuperRecognizer` and `ZipaRecognizer`, and passes both into `handle_score_request`. The image gains
`onnxruntime` and a download step for `ZIPA-CR-small`'s ONNX checkpoint + `tokens.txt` (from
`anyspeech/zipa-small-crctc-500k` on Hugging Face, via `huggingface_hub` — already a pinned
dependency), mirroring the existing `_download_recognizer` pattern. Whether any additional package
beyond `onnxruntime` is needed for pre/post-processing is unverified — see "Deferred to
implementation."

## Data flow

One `/score` request → `handle_score_request` decodes audio once (unchanged `decode_audio` +
`load_waveform`) → scores with HuPER against ARPAbet canonical phones (served, unchanged) → scores
the same waveform with ZIPA-CR against IPA-mapped canonical phones (logged only) → returns exactly
today's `ScoreResponse`.

## Error handling

`score_pronunciation` and `ZipaRecognizer` raise on bad input exactly like the HuPER path already
does (out-of-vocabulary phone, audio too short, etc.) — no special-casing for ZIPA inside those
functions. `handle_score_request`'s comparison call is wrapped in a single broad `try/except
Exception`, logged and dropped, so a ZIPA-side failure (model issue, mapping gap, anything) never
changes the HTTP status code or response body a caller sees.

## Testing

- `tests/test_models.py`: `ZipaRecognizer` tested the same way `HuperRecognizer` is — a fake covering
  `label2id`/`id2label`/`log_probs`, no real model load in unit tests.
- `tests/test_arpabet_to_ipa.py`: table coverage for a plain phone (1:1 mapping), a diphthong
  (2-phone expansion), and an out-of-table phone (explicit failure, not a silent drop).
- `tests/test_handler.py`: existing HuPER-path cases unchanged; new case asserts a raised exception
  from the ZIPA call site is caught and the returned `ScoreResponse` is identical to what it would be
  without the comparison call at all.
- No TS-side test changes — the wire contract doesn't move.

## Deferred to implementation (research tasks, not resolved by this design)

- **ONNX Runtime integration shape.** `ZipaRecognizer`'s exact session input/output tensor shapes,
  and whether any preprocessing beyond `load_waveform`'s existing 16kHz-mono output is needed —
  verify against the actual exported model and `lingjzhu/zipa`'s `inference/inference.py`, not
  assumed from the README's CLI usage.
- **Checkpoint download step.** Confirm `anyspeech/zipa-small-crctc-500k`'s exact file layout on
  Hugging Face (the ONNX weights file plus `tokens.txt`) for the image's download/bake step.
- **Non-phone token set.** HuPER's `NON_PHONE_TOKENS` (`<PAD>`, `<UNK>`, `<BOS>`, `<EOS>`, `|`) is
  specific to its vocabulary; ZIPA's CTC blank/special-token set must be confirmed against its actual
  `tokens.txt`, not assumed to match.
- **Full `ARPABET_TO_IPA` table contents.** The mapping shape (including diphthong expansion) is
  decided; the specific IPA symbol chosen for each ARPAbet phone needs to be checked against ZIPA's
  actual vocabulary, not guessed from general IPA knowledge.
- **License confirmation for PhoneticXeus**, if it's ever revisited — not checked as part of this
  design since it wasn't chosen.

## Further notes

`ZIPA-CR-small` is meaningfully newer and better-maintained than Allosaurus, but is still a
research-lab artifact (ACL 2025), not a `transformers`-native model backed by a large ongoing org the
way `huper29/huper_recognizer`'s underlying WavLM architecture is. Its production maturity, like
Allosaurus's would have been, is a real open question the parallel-comparison period is partly meant
to answer — the difference is it starts from real, current, actively-used footing rather than a
four-year-dormant one.
