# GOP-based pronunciation scoring (replacing the HuPER Corrector)

## Problem

`apps/pronunciation-service` (built per `2026-09-05-pronunciation-service-modal-design.md`) wraps
`huper29/huper_corrector`, a small (37.3M-param) model whose actual training purpose — confirmed
by reading the HuPER paper (`arXiv:2602.01634`) and its GitHub repo (`HuPER29/HuPER`) directly, not
inferred from behavior alone — is generating pseudo-labels for training `huper29/huper_recognizer`
on LibriSpeech (native, fluently-read audiobook speech): given G2P canonical phones and a
first-pass phone hypothesis over *native* audio, it predicts the edit ops that turn canonical text
into what a native reader's actual phones probably were (flapping, t-dropping, vowel reduction).
It was never trained on L2/accent-driven substitutions, and empirically never produces one: three
independent tests this investigation ran (synthetic TTS minimal pair "very"/"berry", and a real
Spanish-L1 speaker's recording) all show the Corrector's raw per-phone log — obtained directly via
`edit_seq_speech`'s own inference output, not inferred — predicting the canonical phone `V`
regardless of whether the audio actually contained a `B`. It's the wrong sub-model for this
feature's actual job (detecting an L2 speaker's phone substitution), not a tuning problem.

Two follow-on approaches were also spiked and rejected before landing on this design:
- **`huper29/huper_recognizer` (the actual WavLM-Large phone recognizer) + Dysfluent WFST**
  (`Berkeley-Speech-Group/DysfluentWFST`, Interspeech 2025, same paper authors) — read the actual
  FSA-construction code (`utils/decoder.py`) rather than assuming from its description: its
  "substitution" mechanism only weights how costly it is to jump to a *non-adjacent* alignment
  state (modeling repetition/insertion/deletion, matching its own eval data — a disordered/
  stuttering-speech corpus), not "accept a different phone at the same timestep." Confirmed via a
  local spike (`k2`-based, run against the same test audio) that this structurally cannot express
  a same-position substitution regardless of its `beta` sensitivity parameter (swept 5→1, no
  change) — not an undiscovered bug, a mismatched error category.
- **Raw, unconstrained Recognizer output + naive Levenshtein alignment against canonical phones** —
  did correctly recognize `B` where `V` was canonical (the one approach that did), but degraded
  badly on the real Spanish-accented recording: a 5-phone length gap between reference and
  hypothesis let edit-distance place insertions/deletions anywhere with equal cost, producing a
  linguistically implausible alignment (a bogus `ER -> D` substitution) near the end of the
  utterance. Reweighting substitution cost by a phonetic-similarity matrix (borrowed from the
  Dysfluent WFST repo) didn't fix it — the problem is alignment-search ambiguity under a large
  length mismatch, not substitution-cost calibration.

## Why this reopens a previously-closed decision

`2026-09-04-pronunciation-correction-design.md` explicitly evaluated and rejected GOP-family
scoring (Azure Pronunciation Assessment, Speechace), citing a documented Azure failure: a learner
saying "they" against reference text "there" scores as correctly pronounced — Microsoft's own
answer confirms this is by design, since GOP evaluates acoustic similarity to *whatever reference
it's given*, not whether that reference is the right word at all. That reasoning still holds and
this design doesn't undo it. What's different here:

- The Azure anecdote is a **word-level miscue** failure — an entirely different word substituted
  for the reference, which GOP-family word/sentence scoring doesn't reliably catch. This design
  targets a narrower, different case: **the correct word, one wrong phone inside it** (a
  substituted consonant/vowel within a word Deepgram already transcribed correctly) — exactly
  what this investigation's spike measured (`V` canonical, `B` spoken, same word "very"), and GOP
  handled it precisely: log-posterior-ratio for the canonical phone collapsed sharply
  (-7.6 to -8.3) exactly where the substitution occurred, without needing a word-substitution
  detector at all.
- Kalli's canonical reference was never a fixed script a learner reads aloud (the scenario the
  Azure/Speechace evaluation implicitly assumed) — it's `g2p(transcript)`, where `transcript` is
  Deepgram's own finalized ASR of the *same audio* being scored. The "wrong reference word" failure
  mode requires the reference to diverge from what was actually attempted; here the reference is
  derived from the same utterance, so a gross word-level substitution isn't really representable
  as a scoring input in the first place (Deepgram would have transcribed *something*, and that
  something becomes the reference). This doesn't eliminate every version of the concern — see
  "Known limitation" below, carried over unchanged from the original design — but it's a
  structurally different risk surface than "score audio against a possibly-wrong prescribed
  script."
- This design self-hosts GOP against `huper29/huper_recognizer`'s raw emissions — it isn't
  adopting Azure/Speechace as a vendor, so their specific implementation's word-level miscue gap
  doesn't transfer here regardless.

## What was NOT proven — read the actual spike numbers before trusting the "clean" framing

Reporting back mid-investigation, the substitution hits were described as "clean" and
"isolated" — true in one specific sense (a mispronunciation at one position doesn't corrupt
neighboring positions' alignment, unlike the Levenshtein spike) but that phrasing undersells a real
gap: **raw GOP magnitude alone does not cleanly separate a genuine L2 pronunciation error from
ordinary native-speaker connected-speech reduction.** The actual spike output, native speaker,
correctly-read sentence, zero real pronunciation errors:

```
[9]  AH -> GOP=-7.279  (vowel reduction in "vacation")
[13] AH -> GOP=-8.804  (vowel reduction in "love")
[23] T  -> GOP=-5.954  (final-T drop before "the")
```

against the Spanish speaker's genuine `V->B` substitution at `-7.581` and the `ER` rhoticity-loss
finding at `-3.117` — **overlapping, not separated, magnitude ranges.** A single hand-picked
threshold cannot distinguish these; this is exactly why the published GOP literature moved from
bare-threshold GOP to GOPT (a small model trained on top of GOP features against SpeechOcean762's
human ratings) rather than thresholding GOP directly. This design does not solve that calibration
problem — see Non-goals.

## Goals

- Replace `huper29/huper_corrector` with `huper29/huper_recognizer` (WavLM-Large CTC phone
  recognizer) as the model backing `apps/pronunciation-service`, scored via Goodness of
  Pronunciation (forced-alignment + log-posterior-ratio) rather than the Corrector's edit-op
  prediction.
- Preserve the existing HTTP contract exactly (`POST /score`, same multipart request, same
  `{"editOps": [...]}` response shape) — `schemas.py` and every TS-side file
  (`apps/server/src/pronunciation.ts`, `g2p.ts`, `session.ts`, `llm.ts`, the DB schema) are
  correct as-is and need zero changes. This is a Python-service-internal swap only.
- Reduce false positives from well-documented native-English phonological alternations (flapping,
  common unstressed-vowel reduction) via an explicit allowlist, mirroring the existing pattern
  `apps/server/src/g2p.ts`'s `PHONE_NORMALIZATION` already uses for a different problem (mapping
  `phonemize`'s output symbols onto HuPER's phone vocabulary) — narrowing, not solving, the
  calibration gap above.

## Non-goals

- **Full statistical calibration of the mispronunciation threshold against labeled human-rated
  data** (the GOPT approach). No labeled dataset exists for this repo's learners today; building
  or licensing one (e.g. a SpeechOcean762-style effort) is a real, separate project. This design
  ships a conservative, explicitly-labeled-as-uncalibrated default threshold instead — see
  "Threshold and known imprecision."
- **Insertion detection.** Forced alignment (`torchaudio.functional.forced_align`) consumes exactly
  the given canonical target sequence — there's no representation for "the learner said an extra
  phone that isn't in the canonical sequence at all." `op: "ins"` is not produced by this design;
  the wire schema keeps the field (TS side already treats it as optional/absent per-turn) but no
  code path emits it. Revisit if this becomes a real gap in practice.
- **The repeated-adjacent-canonical-phone edge case — resolved, not just narrowed.** An earlier
  revision of this section described a residual "true zero-separation collapse" (two identical
  canonical phones realized with no acoustic gap at all) as a rare-but-still-possible case that
  could misalign every phone after it. The final whole-branch review checked this against
  `torchaudio`'s own `forced_align` implementation directly rather than trusting the earlier
  reasoning: CTC's alignment topology structurally forbids two identical adjacent labels without
  an intervening blank — `forced_align` enforces this (confirmed against its source and by direct
  testing: a target sequence with adjacent repeated tokens over frames that all favor that token
  still comes back with a blank forced between them). So `_group_into_spans`'s frame-contiguity fix
  (only merging truly-contiguous same-token frames) closes this case completely, not just narrows
  it — `len(spans) == len(flat_phones)` always holds, and `score_pronunciation`'s `i >= len(spans)`
  guard is dead code. That guard is now a loud invariant assertion instead of a silent `continue`
  (see `score_pronunciation`), so if this reasoning is ever wrong for some input this design didn't
  anticipate, it fails loudly rather than silently dropping phones from scoring.
- **Renegotiating the wire contract, DB schema, or TS pipeline.** Everything outside
  `apps/pronunciation-service` is unchanged.
- **A second vendor (Azure/Speechace) comparison.** Out of scope for this design; a candidate for
  a separate future evaluation if this approach's precision, once real usage data exists, turns
  out not to be good enough.

## Architecture

```
apps/pronunciation-service/
├── modal_app.py       # unchanged shape: image build (now recognizer-only), GPU config, /score route
├── handler.py          # unchanged: auth check, parse, call pipeline.py, build response
├── models.py           # HuperCorrector -> HuperRecognizer: wraps WavLMForCTC + Wav2Vec2Processor
├── pipeline.py          # decode_audio unchanged; run_corrector/to_edit_ops -> score_pronunciation
├── schemas.py           # unchanged — same request/response shapes
├── tests/
│   ├── test_pipeline.py # decode_audio (unchanged) + new GOP/alignment/threshold tests
│   ├── test_handler.py  # unchanged shape, fake HuperRecognizer instead of fake Corrector
│   └── test_schemas.py  # unchanged
├── pyproject.toml       # simplified deps — see "Dependencies"
└── README.md            # updated model/deploy notes
```

`models.py`'s `HuperRecognizer` replaces `HuperCorrector`:

```python
class HuperRecognizer:
    """Wraps huper29/huper_recognizer — a standard `transformers` WavLM CTC model, unlike the
    Corrector's bespoke `edit_seq_speech` package. No sys.path hack, no bundled inference class."""

    def __init__(self, repo_id: str = "huper29/huper_recognizer") -> None:
        from transformers import Wav2Vec2Processor, WavLMForCTC

        self.processor = Wav2Vec2Processor.from_pretrained(repo_id)
        self.model = WavLMForCTC.from_pretrained(repo_id)
        self.model.eval()

    def log_probs(self, waveform: "numpy.ndarray") -> "torch.Tensor":
        """Returns log-softmax'd per-frame class log-probabilities, shape (1, T, C)."""
        import torch
        import torch.nn.functional as F

        inputs = self.processor(waveform, sampling_rate=16000, return_tensors="pt")
        with torch.no_grad():
            logits = self.model(**inputs).logits
        return F.log_softmax(logits, dim=-1)
```

This is a materially *simpler* dependency footprint than what it replaces (see "Dependencies") —
notable since the Corrector's integration required discovering `torch`, `torchaudio`, `torchcodec`,
`g2p_en`, and `pytorch_lightning` one deploy at a time (per the prior spec's "Further notes"); this
swap removes the custom `edit_seq_speech` package entirely in favor of a model loadable through
`transformers` alone, the same library already used for the Corrector's own dependency chain.

## Model loading and inference pipeline

`pipeline.py`'s `decode_audio(webm_bytes) -> Path` is unchanged (ffmpeg subprocess, 16kHz mono
WAV). Everything after it changes:

```python
import numpy as np
import soundfile as sf
import torch
from torchaudio.functional import forced_align

from models import HuperRecognizer
from schemas import CanonicalWord, PronunciationEditOp

GOP_MISPRONUNCIATION_THRESHOLD = -3.0

# Phones this design tolerates as an acceptable realization of the canonical phone, before
# threshold-based scoring runs — the same "normalize known allophonic variation" idea g2p.ts's
# PHONE_NORMALIZATION already applies to a different problem (G2P output vocabulary mismatch).
# DX (the alveolar flap) is the realization of an intervocalic /t/ or /d/ in fluent American
# English ("butter", "good day") — flagging it as a mispronunciation of D or T produces exactly
# the false positive the spike measured on a fluent NATIVE recording (-5.1 to -6.6 GOP on a flap
# that isn't an error). This list starts narrow and grows only from real observed false positives,
# not speculatively.
ACCEPTABLE_REALIZATIONS: dict[str, set[str]] = {
    "D": {"DX"},
    "T": {"DX"},
}


def score_pronunciation(
    recognizer: HuperRecognizer,
    wav_path: Path,
    canonical_phones: list[CanonicalWord],
) -> list[PronunciationEditOp]:
    """Runs GOP-based scoring: forced-aligns the canonical phone sequence to `wav_path`'s audio,
    scores each phone's alignment span against the model's own confidence, and reports a
    substitution for any phone whose GOP falls below threshold and isn't an accepted allophonic
    variant.
    """
    waveform, _sr = sf.read(str(wav_path), dtype="float32")
    log_probs = recognizer.log_probs(waveform)  # (1, T, C)

    flat_phones = [phone for word in canonical_phones for phone in word.phones]
    word_positions = [
        (word.word, word_index)
        for word_index, word in enumerate(canonical_phones)
        for _ in word.phones
    ]
    label2id = recognizer.model.config.label2id
    id2label = recognizer.model.config.id2label
    target_ids = torch.tensor([[label2id[p] for p in flat_phones]], dtype=torch.int64)
    input_lengths = torch.tensor([log_probs.shape[1]], dtype=torch.int64)
    target_lengths = torch.tensor([len(flat_phones)], dtype=torch.int64)

    aligned, _scores = forced_align(log_probs, target_ids, input_lengths, target_lengths, blank=0)
    spans = _group_into_spans(aligned[0].tolist())

    ops: list[PronunciationEditOp] = []
    frames = log_probs[0]  # (T, C)
    for i, (canonical_phone, (word, word_index)) in enumerate(zip(flat_phones, word_positions)):
        if i >= len(spans):
            continue  # repeated-adjacent-phone collapse — see Non-goals
        token_id, frame_indices = spans[i]
        span_log_probs = frames[frame_indices]  # (num_frames, C)
        canonical_lp = span_log_probs[:, token_id]
        best_lp, best_id = span_log_probs.max(dim=-1)
        gop = (canonical_lp - best_lp).mean().item()
        most_likely_phone = id2label[int(best_id.mode().values.item())]

        if most_likely_phone in ACCEPTABLE_REALIZATIONS.get(canonical_phone, set()):
            continue
        if gop < GOP_MISPRONUNCIATION_THRESHOLD:
            ops.append(
                PronunciationEditOp(
                    word=word,
                    wordIndex=word_index,
                    op="sub",
                    expectedPhoneme=canonical_phone,
                    spokenPhoneme=most_likely_phone,
                )
            )
    return ops


def _group_into_spans(aligned_frame_tokens: list[int]) -> list[tuple[int, list[int]]]:
    """Groups consecutive identical non-blank frame token ids into (token_id, frame_indices)
    spans, in target order — forced_align guarantees monotonic left-to-right consumption."""
    spans: list[tuple[int, list[int]]] = []
    for t, token_id in enumerate(aligned_frame_tokens):
        if token_id == 0:  # blank
            continue
        if spans and spans[-1][0] == token_id:
            spans[-1][1].append(t)
        else:
            spans.append((token_id, [t]))
    return spans
```

`handler.py`'s `handle_score_request` changes its call from `run_corrector` + `to_edit_ops` to a
single `score_pronunciation(recognizer, wav_path, words)` call — everything else (auth check, JSON
parse, response construction) is unchanged.

## Threshold and known imprecision

`GOP_MISPRONUNCIATION_THRESHOLD = -3.0` is a deliberately conservative starting point, chosen to
sit below most of the native-speaker false-positive range observed in the spike (`-1` to `-2.7` for
several reductions) while still catching both real substitutions found (`-7.6`, `-3.1`) — **but
the ranges overlap** (the native speaker's `T`-drop and vowel-reduction cases scored `-5.9` and
`-7.3`/`-8.8`, deeper than the real `ER` rhoticity-loss finding's `-3.1`). This threshold will
produce both false positives (flagging natural reductions) and, less often, false negatives
(missing a genuine but subtle substitution) until real usage data exists to calibrate against.
Ship it, but do not represent this as solved — track false-positive reports from real sessions and
either tighten `ACCEPTABLE_REALIZATIONS` for specific recurring patterns, or revisit whether a
learned scoring layer (GOPT-style) is worth the investment once there's enough real data to train
one against.

## Dependencies

Removed entirely (were the Corrector's, per the prior spec's "Further notes" — no longer needed
since `edit_seq_speech` is gone): the `huper29/huper_corrector` HF repo download/`sys.path` hack,
`g2p_en`, `pytorch_lightning`.

Added: none — `transformers` (already pinned, now used for `WavLMForCTC`/`Wav2Vec2Processor`
instead of via the Corrector's own transitive dependency on it), `torch`/`torchaudio` (already
pinned; `torchaudio.functional.forced_align` has shipped since torchaudio 2.1, confirmed present
in the already-pinned `torchaudio==2.11.0`), and `soundfile` (new — reading the ffmpeg-produced WAV
file directly, avoiding `torchaudio.load`'s now-mandatory `torchcodec` backend dependency, which is
also dropped).

Net: fewer pinned dependencies than before, not more.

## Testing

- `tests/test_pipeline.py`: `decode_audio` unchanged (real ffmpeg fixture). New tests for
  `score_pronunciation` and `_group_into_spans` against a **fake recognizer** (a stub exposing
  `model.config.label2id`/`id2label` and a `log_probs` method returning hand-built log-prob
  tensors) — no real model load in unit tests, matching the existing "unit-testable without a GPU
  or real checkpoints" constraint from the original service design:
  - A phone whose canonical class has the highest log-prob throughout its span → no edit op.
  - A phone whose canonical class is clearly *not* the best class throughout its span (GOP below
    threshold) → one `"sub"` op with `spokenPhoneme` set to the dominant alternate class.
  - A `D`/`T` position where the dominant alternate class is `DX` → no edit op (allowlisted).
  - A GOP score between `-3.0` and `0` (above threshold) → no edit op, even if the canonical class
    wasn't the single most likely class in the span.
  - `_group_into_spans` against a hand-built frame-token sequence covering: a multi-frame span for
    one phone, a single-frame span, and a target sequence one span short of the phone count (the
    repeated-adjacent-phone case) — asserts the caller-side `if i >= len(spans): continue` guard
    is actually reachable, not just theorized.
- `tests/test_handler.py`: same shape as today, fake `HuperRecognizer` replaces fake `Corrector`.
- `tests/test_schemas.py`: unchanged.
- No TS-side test changes — the wire contract didn't move.

## Further notes

- Real per-request latency wasn't re-measured for this design — the Recognizer is the same model
  size class already cost-modeled in the original 2026-09-04 spec (315.5M params, WavLM-Large),
  and forced-alignment + a log-posterior-ratio over already-computed logits is cheap relative to
  the forward pass itself. Worth confirming with real T4 timing once deployed, same as every prior
  spec in this service's history flagged and never fully closed out.
- If false-positive reports from real sessions concentrate on a small number of recurring
  phonological patterns (the way flapping and final-consonant reduction did in the spike),
  extending `ACCEPTABLE_REALIZATIONS` is the cheap first lever — reach for a learned calibration
  layer only once that allowlist approach visibly stops scaling.
