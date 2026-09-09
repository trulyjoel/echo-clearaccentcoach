# GOP-Based Pronunciation Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `apps/pronunciation-service`'s HuPER Corrector (which structurally cannot detect
L2 phone substitutions like V→B — confirmed by direct investigation, not assumption) with
GOP-based scoring against `huper29/huper_recognizer`'s raw emissions, with no change to the
service's HTTP contract or any TS-side code.

**Architecture:** `torchaudio.functional.forced_align` aligns the canonical phone sequence to the
recognizer's per-frame log-probabilities; a log-posterior-ratio (canonical phone vs. the frame
span's most-likely phone) below a fixed threshold, filtered through a small allowlist of known
native-English phonological alternations, becomes a `"sub"` edit op in the existing wire format.

**Tech Stack:** Python 3.13, `transformers` (`WavLMForCTC`, `Wav2Vec2Processor`), `torch`/
`torchaudio` (`forced_align`), `soundfile`, `pytest`, `ruff`, `ty`. No new runtime dependency beyond
`soundfile` — see spec's "Dependencies" section.

**Spec:** `docs/superpowers/specs/2026-09-08-gop-pronunciation-scoring-design.md`

## Global Constraints

- The `POST /score` HTTP contract, `schemas.py`'s request/response shapes, and every TS-side file
  are unchanged — this plan touches only `apps/pronunciation-service/`.
- `op: "ins"` is never produced by this design (forced alignment can't represent an extra,
  non-canonical phone) — do not add insertion-detection logic.
- `GOP_MISPRONUNCIATION_THRESHOLD = -3.0` and `ACCEPTABLE_REALIZATIONS = {"D": {"DX"}, "T": {"DX"}}`
  are the exact starting values from the spec — do not tune them differently without updating the
  spec first.
- Tests must not require real model weights, network access, or a GPU (matches the existing
  service's testing constraint) — use a fake `Recognizer` exposing hand-built log-probability
  tensors, same spirit as the existing `FakeCorrector` pattern in `tests/test_handler.py`.

---

### Task 1: `_group_into_spans` helper

**Files:**
- Modify: `apps/pronunciation-service/pipeline.py`
- Test: `apps/pronunciation-service/tests/test_pipeline.py`

**Interfaces:**
- Produces: `_group_into_spans(aligned_frame_tokens: list[int]) -> list[tuple[int, list[int]]]` —
  groups consecutive identical non-blank (`0`) frame token ids into `(token_id, frame_indices)`
  spans, in the order they first appear. Consumed by Task 2's `score_pronunciation`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/pronunciation-service/tests/test_pipeline.py` (new imports at the top of the file
alongside the existing ones):

```python
from pipeline import _group_into_spans
```

```python
def test_group_into_spans_groups_a_single_multi_frame_span():
    assert _group_into_spans([0, 0, 5, 5, 5, 0]) == [(5, [2, 3, 4])]


def test_group_into_spans_keeps_distinct_adjacent_phones_separate():
    assert _group_into_spans([0, 3, 4, 0]) == [(3, [1]), (4, [2])]


def test_group_into_spans_ignores_blank_only_input():
    assert _group_into_spans([0, 0, 0]) == []


def test_group_into_spans_collapses_a_repeated_adjacent_phone_with_no_blank_between():
    # Known limitation (see the spec's Non-goals): forced_align can leave zero separation between
    # two identical adjacent target phones when nothing acoustic distinguishes them, so both target
    # positions land in one span instead of two. Asserted here as documented behavior, not treated
    # as a bug to silently fix.
    assert _group_into_spans([0, 7, 7, 7, 0]) == [(7, [1, 2, 3])]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_pipeline.py -k group_into_spans -v`
Expected: FAIL with `ImportError: cannot import name '_group_into_spans'`

- [ ] **Step 3: Implement `_group_into_spans`**

Add to `apps/pronunciation-service/pipeline.py`, above `decode_audio` (near the top of the file,
after the existing imports and `_NO_INSERTION` constant):

```python
def _group_into_spans(aligned_frame_tokens: list[int]) -> list[tuple[int, list[int]]]:
    """Groups consecutive identical non-blank frame token ids into (token_id, frame_indices)
    spans, in target order — forced_align guarantees monotonic left-to-right target consumption,
    so this never needs to look ahead or reorder anything."""
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_pipeline.py -k group_into_spans -v`
Expected: 4 passed

- [ ] **Step 5: Lint and typecheck**

Run: `cd apps/pronunciation-service && uv run ruff check . && uv run ty check .`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/pronunciation-service/pipeline.py apps/pronunciation-service/tests/test_pipeline.py
git commit -m "Add _group_into_spans helper for GOP-based phone alignment"
```

---

### Task 2: `score_pronunciation` and the `Recognizer` protocol

**Files:**
- Modify: `apps/pronunciation-service/pipeline.py`
- Test: `apps/pronunciation-service/tests/test_pipeline.py`

**Interfaces:**
- Consumes: `_group_into_spans` (Task 1).
- Produces: `Recognizer` (a `typing.Protocol`, structurally requiring `log_probs(waveform) ->
  torch.Tensor`, `label2id: dict[str, int]`, `id2label: dict[int, str]`) and
  `score_pronunciation(recognizer: Recognizer, waveform, canonical_phones: list[CanonicalWord]) ->
  list[PronunciationEditOp]`. Consumed by Task 4's `handler.py` rewrite (which produces the real
  `waveform` argument via `load_waveform`). `models.py`'s real `HuperRecognizer` (Task 3) satisfies
  this protocol structurally — no inheritance needed, matching the existing `Corrector` protocol's
  relationship to `HuperCorrector`.

- [ ] **Step 1: Write the failing tests**

Add to the top of `apps/pronunciation-service/tests/test_pipeline.py`:

```python
import torch

from pipeline import score_pronunciation
from schemas import CanonicalWord
```

Add this fake and its tests anywhere below the existing imports:

```python
# A tiny synthetic vocabulary — not real ARPAbet ids — sized just large enough to construct
# hand-picked log-probability rows with a known, predictable GOP outcome per phone. id 0 is
# always blank, matching the real recognizer's convention.
_ID2LABEL = {0: "<pad>", 1: "D", 2: "DX", 3: "V", 4: "B"}
_LABEL2ID = {label: id_ for id_, label in _ID2LABEL.items()}


class FakeRecognizer:
    """Satisfies pipeline.Recognizer without loading any real model — returns a pre-built
    log-probability tensor regardless of the waveform it's given."""

    def __init__(self, log_probs: torch.Tensor):
        self._log_probs = log_probs
        self.label2id = _LABEL2ID
        self.id2label = _ID2LABEL

    def log_probs(self, waveform: object) -> torch.Tensor:
        return self._log_probs


def _row(probs: dict[str, float]) -> list[float]:
    """One frame's probability distribution over the fake vocabulary, in id order."""
    return [probs.get(_ID2LABEL[i], 1e-9) for i in range(len(_ID2LABEL))]


def _log_probs_tensor(rows: list[list[float]]) -> torch.Tensor:
    return torch.log(torch.tensor([rows], dtype=torch.float32))


def test_score_pronunciation_reports_nothing_for_a_confident_correct_phone():
    # Two frames, both overwhelmingly "D" — matches the canonical phone throughout.
    log_probs = _log_probs_tensor(
        [_row({"D": 0.985, "DX": 0.005, "V": 0.005, "<pad>": 0.005})] * 2
    )
    recognizer = FakeRecognizer(log_probs)
    canonical = [CanonicalWord(word="do", phones=["D"])]

    # FakeRecognizer.log_probs ignores its argument, so None stands in for "no real waveform" —
    # score_pronunciation always takes one (real audio, once handler.py wires it up in Task 4),
    # this is just how the fake is exercised in isolation here.
    assert score_pronunciation(recognizer, None, canonical) == []


def test_score_pronunciation_flags_a_confident_substitution():
    # Two frames, both overwhelmingly "B" where "V" was canonical — the exact V/B case this
    # whole design exists to catch.
    log_probs = _log_probs_tensor(
        [_row({"B": 0.985, "V": 0.005, "D": 0.005, "<pad>": 0.005})] * 2
    )
    recognizer = FakeRecognizer(log_probs)
    canonical = [CanonicalWord(word="very", phones=["V"])]

    ops = score_pronunciation(recognizer, None, canonical)

    assert len(ops) == 1
    assert ops[0].word == "very"
    assert ops[0].wordIndex == 0
    assert ops[0].op == "sub"
    assert ops[0].expectedPhoneme == "V"
    assert ops[0].spokenPhoneme == "B"


def test_score_pronunciation_allows_a_flap_as_an_acceptable_realization_of_d():
    # Confidently "DX", not "D" — but DX is an allowlisted realization of D (flapping), so this
    # must not be reported even though raw GOP would be strongly negative.
    log_probs = _log_probs_tensor(
        [_row({"DX": 0.985, "D": 0.005, "V": 0.005, "<pad>": 0.005})] * 2
    )
    recognizer = FakeRecognizer(log_probs)
    canonical = [CanonicalWord(word="good", phones=["D"])]

    assert score_pronunciation(recognizer, None, canonical) == []


def test_score_pronunciation_ignores_a_mismatch_above_threshold():
    # "D" is not the single most-likely class, but the gap to the best class ("V") is mild enough
    # to stay above GOP_MISPRONUNCIATION_THRESHOLD (-3.0) — not flagged.
    log_probs = _log_probs_tensor(
        [_row({"D": 0.2, "DX": 0.05, "V": 0.4472, "B": 0.05, "<pad>": 0.2528})] * 2
    )
    recognizer = FakeRecognizer(log_probs)
    canonical = [CanonicalWord(word="good", phones=["D"])]

    # GOP = log(0.2) - log(0.4472) ≈ -0.80, well above the -3.0 threshold.
    assert score_pronunciation(recognizer, None, canonical) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_pipeline.py -k score_pronunciation -v`
Expected: FAIL with `ImportError: cannot import name 'score_pronunciation'`

- [ ] **Step 3: Implement `Recognizer` and `score_pronunciation`**

Add two new imports to `apps/pronunciation-service/pipeline.py`'s existing top-of-file import
block (`Protocol` is already imported there for the `Corrector` protocol this task will eventually
retire — see Task 4 — so it doesn't need re-adding):

```python
import torch
from torchaudio.functional import forced_align
```

Then add the following below `_group_into_spans`:

```python
GOP_MISPRONUNCIATION_THRESHOLD = -3.0

# Phones tolerated as an acceptable realization of the canonical phone, checked before
# threshold-based scoring — mirrors g2p.ts's PHONE_NORMALIZATION idea (normalize known variation)
# applied to a different problem. DX (the alveolar flap) is the normal realization of an
# intervocalic /t/ or /d/ in fluent American English ("butter", "good day") — flagging it as a
# mispronunciation of D or T produced exactly this false positive on a fluent native recording
# during this feature's investigation. Starts narrow; grows only from real observed false
# positives, not speculatively.
ACCEPTABLE_REALIZATIONS: dict[str, set[str]] = {
    "D": {"DX"},
    "T": {"DX"},
}


class Recognizer(Protocol):
    """What score_pronunciation needs from a phone-recognition model — satisfied structurally by
    models.py's HuperRecognizer, with no inheritance relationship required."""

    label2id: dict[str, int]
    id2label: dict[int, str]

    def log_probs(self, waveform) -> torch.Tensor:
        """Returns log-softmax'd per-frame class log-probabilities, shape (1, T, C)."""
        ...


def score_pronunciation(
    recognizer: Recognizer,
    waveform,
    canonical_phones: list[CanonicalWord],
) -> list[PronunciationEditOp]:
    """Forced-aligns `canonical_phones` to `recognizer`'s emissions for `waveform` (a 16kHz mono
    array — see Task 4's `load_waveform` for how a real one is produced), then reports a
    substitution for any phone whose Goodness-of-Pronunciation score falls below threshold and
    isn't an accepted allophonic variant (see ACCEPTABLE_REALIZATIONS).

    Does not detect insertions (forced alignment can't represent an extra, non-canonical phone —
    see the design spec's Non-goals) or, in the rare case of two identical adjacent canonical
    phones with no acoustic separation between them, the second occurrence (see
    _group_into_spans's docstring).
    """
    log_probs = recognizer.log_probs(waveform)

    flat_phones = [phone for word in canonical_phones for phone in word.phones]
    word_positions = [
        (word.word, word_index)
        for word_index, word in enumerate(canonical_phones)
        for _ in word.phones
    ]
    target_ids = torch.tensor(
        [[recognizer.label2id[p] for p in flat_phones]], dtype=torch.int64
    )
    input_lengths = torch.tensor([log_probs.shape[1]], dtype=torch.int64)
    target_lengths = torch.tensor([len(flat_phones)], dtype=torch.int64)

    aligned, _scores = forced_align(log_probs, target_ids, input_lengths, target_lengths, blank=0)
    spans = _group_into_spans(aligned[0].tolist())

    ops: list[PronunciationEditOp] = []
    frames = log_probs[0]  # (T, C)
    for i, (canonical_phone, (word, word_index)) in enumerate(zip(flat_phones, word_positions)):
        if i >= len(spans):
            continue  # repeated-adjacent-phone collapse — see _group_into_spans's docstring
        token_id, frame_indices = spans[i]
        span_log_probs = frames[frame_indices]  # (num_frames, C)
        canonical_lp = span_log_probs[:, token_id]
        best_lp, best_id = span_log_probs.max(dim=-1)
        gop = (canonical_lp - best_lp).mean().item()
        most_likely_phone = recognizer.id2label[int(best_id.mode().values.item())]

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_pipeline.py -k score_pronunciation -v`
Expected: 4 passed

- [ ] **Step 5: Lint and typecheck**

Run: `cd apps/pronunciation-service && uv run ruff check . && uv run ty check .`
Expected: no errors (fix any unused-import/type warnings `ty` raises on the `Protocol` method body's
`...` before committing)

- [ ] **Step 6: Commit**

```bash
git add apps/pronunciation-service/pipeline.py apps/pronunciation-service/tests/test_pipeline.py
git commit -m "Add GOP-based score_pronunciation and the Recognizer protocol"
```

---

### Task 3: `HuperRecognizer` in `models.py`

**Files:**
- Modify: `apps/pronunciation-service/models.py`

**Interfaces:**
- Produces: `HuperRecognizer.__init__(repo_id: str = "huper29/huper_recognizer")`, `.log_probs(waveform: numpy.ndarray) -> torch.Tensor`, `.label2id: dict[str, int]`, `.id2label: dict[int, str]` — satisfies Task 2's `Recognizer` protocol structurally. Consumed by Task 5's `modal_app.py`.

No test for this task — matches this file's existing precedent: the real `HuperCorrector` class it
replaces has zero test coverage today (loading real model weights isn't meaningfully unit-testable
without a GPU or network access; `Recognizer`'s protocol contract is what's tested, via
`FakeRecognizer`, in Task 2).

- [ ] **Step 1: Replace `HuperCorrector` with `HuperRecognizer`**

Replace the entire contents of `apps/pronunciation-service/models.py` with:

```python
class HuperRecognizer:
    """Wraps huper29/huper_recognizer, a standard `transformers` WavLM-Large CTC phone recognizer —
    unlike the HuPER Corrector this replaces, no bespoke `edit_seq_speech` package or sys.path
    hack is needed; it's loadable through `transformers` alone.
    """

    def __init__(self, repo_id: str = "huper29/huper_recognizer") -> None:
        from transformers import Wav2Vec2Processor, WavLMForCTC

        self.processor = Wav2Vec2Processor.from_pretrained(repo_id)
        self.model = WavLMForCTC.from_pretrained(repo_id)
        self.model.eval()
        self.label2id: dict[str, int] = dict(self.model.config.label2id)
        self.id2label: dict[int, str] = dict(self.model.config.id2label)

    def log_probs(self, waveform):
        """Returns log-softmax'd per-frame class log-probabilities for a 16kHz mono waveform,
        shape (1, T, C)."""
        import torch
        import torch.nn.functional as F

        inputs = self.processor(waveform, sampling_rate=16000, return_tensors="pt")
        with torch.no_grad():
            logits = self.model(**inputs).logits
        return F.log_softmax(logits, dim=-1)
```

- [ ] **Step 2: Lint and typecheck**

Run: `cd apps/pronunciation-service && uv run ruff check . && uv run ty check .`
Expected: no errors. `ty` will report `models.py`'s `transformers`/`torch` imports as unresolved —
these are image-only dependencies (see the spec's "Dependencies" section and Task 5), not part of
this project's local `uv` venv; confirm the existing `# ty: ignore[unresolved-import]` comment
pattern already used elsewhere in this file's git history for the same reason, and add matching
`# ty: ignore[unresolved-import]` comments on the `from transformers import ...` and `import torch`/
`import torch.nn.functional as F` lines.

- [ ] **Step 3: Commit**

```bash
git add apps/pronunciation-service/models.py
git commit -m "Replace HuperCorrector with HuperRecognizer"
```

---

### Task 4: Wire `handler.py` to `score_pronunciation`, retire the Corrector path

**Files:**
- Modify: `apps/pronunciation-service/handler.py`
- Modify: `apps/pronunciation-service/pipeline.py`
- Modify: `apps/pronunciation-service/tests/test_handler.py`
- Modify: `apps/pronunciation-service/tests/test_pipeline.py`

**Interfaces:**
- Consumes: `score_pronunciation` (Task 2), `HuperRecognizer` (Task 3).
- Produces: `handle_score_request`'s first parameter is now named `recognizer` (was `corrector`) —
  consumed by Task 5's `modal_app.py`.

- [ ] **Step 1: Add a real audio-decoding helper next to `decode_audio`**

Add to `apps/pronunciation-service/pipeline.py`, directly below `decode_audio`:

```python
def load_waveform(wav_path: Path):
    """Reads a 16kHz mono WAV file (as produced by decode_audio) into a float32 array, for
    log_probs. Uses soundfile directly rather than torchaudio.load, which as of torchaudio's 2.x
    line requires an additional torchcodec backend dependency this service doesn't otherwise need.
    """
    import soundfile as sf

    waveform, _sample_rate = sf.read(str(wav_path), dtype="float32")
    return waveform
```

- [ ] **Step 2: Write the failing test for `load_waveform`**

Add to `apps/pronunciation-service/tests/test_pipeline.py`:

```python
from pipeline import load_waveform


def test_load_waveform_reads_the_decoded_wav_file():
    webm_bytes = FIXTURE.read_bytes()
    wav_path = decode_audio(webm_bytes)
    try:
        waveform = load_waveform(wav_path)
        assert waveform.ndim == 1  # mono
        assert len(waveform) > 0
    finally:
        wav_path.unlink(missing_ok=True)
```

- [ ] **Step 3: Run the test to verify it fails, then passes**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_pipeline.py -k load_waveform -v`
Expected before Step 2's code exists: FAIL with `ImportError`. After Step 2: 1 passed.
(Step 2's implementation was already written above — running now just confirms it.)

- [ ] **Step 4: Remove the retired Corrector-only functions and their tests**

In `apps/pronunciation-service/pipeline.py`, delete `run_corrector` and its `Corrector` Protocol
entirely (`to_edit_ops` is also retired — GOP scoring builds `PronunciationEditOp`s directly in
`score_pronunciation`, there's no separate mapping step). Delete the `_NO_INSERTION` constant too —
it existed only for `to_edit_ops`'s insertion handling, which no longer exists.

In `apps/pronunciation-service/tests/test_pipeline.py`, delete every test referencing `to_edit_ops`,
`run_corrector`, or `FakeCorrector` (`test_to_edit_ops_*`, `test_run_corrector_*`, the `CANONICAL`
module-level fixture used only by those, and the `FakeCorrector` class) — these covered code that
no longer exists.

- [ ] **Step 5: Rewrite `handle_score_request`**

Replace `apps/pronunciation-service/handler.py`'s body with:

```python
import json

from pydantic import ValidationError

from pipeline import Recognizer, decode_audio, load_waveform, score_pronunciation
from schemas import CanonicalWord, ScoreResponse


class UnauthorizedError(Exception):
    pass


class InvalidRequestError(Exception):
    pass


def handle_score_request(
    recognizer: Recognizer,
    audio_bytes: bytes,
    canonical_phones_json: str,
    authorization: str | None,
    expected_token: str,
) -> ScoreResponse:
    """Runs the full `/score` request: auth check, request parsing, the decode/score pipeline, and
    response construction. Framework-agnostic — the caller (`modal_app.py`) translates the
    exceptions raised here to HTTP status codes.
    """
    if authorization != f"Bearer {expected_token}":
        raise UnauthorizedError("invalid or missing bearer token")

    try:
        raw = json.loads(canonical_phones_json)
        words = [CanonicalWord(**word) for word in raw]
    except (json.JSONDecodeError, TypeError, ValidationError) as exc:
        raise InvalidRequestError(str(exc)) from exc

    wav_path = decode_audio(audio_bytes)
    try:
        waveform = load_waveform(wav_path)
        edit_ops = score_pronunciation(recognizer, waveform, words)
    finally:
        wav_path.unlink(missing_ok=True)

    return ScoreResponse(editOps=edit_ops)
```

- [ ] **Step 6: Rewrite `test_handler.py`'s fakes**

Replace `apps/pronunciation-service/tests/test_handler.py`'s `FakeCorrector` class and its use with:

```python
import json
from pathlib import Path

import pytest

from handler import InvalidRequestError, UnauthorizedError, handle_score_request
from schemas import PronunciationEditOp, ScoreResponse

CANONICAL_JSON = json.dumps([{"word": "hi", "phones": ["HH", "AY"]}])


def test_handle_score_request_rejects_a_missing_bearer_token():
    with pytest.raises(UnauthorizedError):
        handle_score_request(object(), b"audio", CANONICAL_JSON, None, "secret-token")


def test_handle_score_request_rejects_a_wrong_bearer_token():
    with pytest.raises(UnauthorizedError):
        handle_score_request(
            object(), b"audio", CANONICAL_JSON, "Bearer wrong-token", "secret-token"
        )


def test_handle_score_request_rejects_malformed_canonical_phones_json():
    with pytest.raises(InvalidRequestError):
        handle_score_request(
            object(), b"audio", "not json", "Bearer secret-token", "secret-token"
        )


def test_handle_score_request_rejects_canonical_phones_missing_required_fields():
    with pytest.raises(InvalidRequestError):
        handle_score_request(
            object(),
            b"audio",
            json.dumps([{"word": "hi"}]),
            "Bearer secret-token",
            "secret-token",
        )


def test_handle_score_request_returns_edit_ops_on_success(monkeypatch):
    monkeypatch.setattr("handler.decode_audio", lambda _audio_bytes: Path("/tmp/turn.wav"))
    monkeypatch.setattr("handler.load_waveform", lambda _wav_path: object())
    monkeypatch.setattr(
        "handler.score_pronunciation",
        lambda _recognizer, _waveform, _words: [
            PronunciationEditOp(
                word="hi", wordIndex=0, op="sub", expectedPhoneme="AY", spokenPhoneme="EY"
            )
        ],
    )

    result = handle_score_request(
        object(), b"audio", CANONICAL_JSON, "Bearer secret-token", "secret-token"
    )

    assert isinstance(result, ScoreResponse)
    assert len(result.editOps) == 1
    assert result.editOps[0].op == "sub"
    assert result.editOps[0].expectedPhoneme == "AY"
    assert result.editOps[0].spokenPhoneme == "EY"
```

This replaces the whole file's content — the auth/parsing tests are unchanged in spirit, just
passing `object()` instead of `FakeCorrector()` for the now-unused-until-`score_pronunciation`
recognizer argument.

- [ ] **Step 7: Run the full test suite**

Run: `cd apps/pronunciation-service && uv run pytest -v`
Expected: all tests pass, none reference `run_corrector`, `to_edit_ops`, or `FakeCorrector` anymore

- [ ] **Step 8: Lint and typecheck**

Run: `cd apps/pronunciation-service && uv run ruff check . && uv run ty check .`
Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add apps/pronunciation-service/handler.py apps/pronunciation-service/pipeline.py \
  apps/pronunciation-service/tests/test_handler.py apps/pronunciation-service/tests/test_pipeline.py
git commit -m "Wire handler.py to GOP-based score_pronunciation, retire the Corrector path"
```

---

### Task 5: Update `modal_app.py`'s image and route

**Files:**
- Modify: `apps/pronunciation-service/modal_app.py`

**Interfaces:**
- Consumes: `HuperRecognizer` (Task 3), `handle_score_request` (Task 4, `recognizer` parameter name).

No test for this task — `modal_app.py` has no test coverage today (the original service design
explicitly scoped Modal-decorator/deploy testing out; `handler.py`'s orchestration, which this file
only thinly wraps, is what's tested).

- [ ] **Step 1: Replace the image definition and download functions**

In `apps/pronunciation-service/modal_app.py`, delete `_download_corrector` and `_download_nltk_data`
entirely, and delete the `MODEL_DIR = "/model"` constant. Add in their place:

```python
def _download_recognizer() -> None:
    # ty: ignore[unresolved-import] -- only installed inside the Modal image, not the local venv
    from transformers import Wav2Vec2Processor, WavLMForCTC

    Wav2Vec2Processor.from_pretrained("huper29/huper_recognizer")
    WavLMForCTC.from_pretrained("huper29/huper_recognizer")
```

Replace the `image = (...)` block with:

```python
image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("ffmpeg")
    .pip_install(
        "torch==2.14.0",
        "torchaudio==2.11.0",
        "soundfile==0.14.0",
        "transformers==5.16.1",
        "huggingface-hub==1.30.0",
        "fastapi==0.141.1",
        "python-multipart==0.0.32",
        "pydantic==2.13.5",
    )
    .add_local_python_source("handler", "models", "pipeline", "schemas", copy=True)
    .run_function(_download_recognizer)
)
```

- [ ] **Step 2: Update `PronunciationService`**

Replace the `import` line `from models import HuperCorrector` with `from models import
HuperRecognizer`.

Replace the `load` method:

```python
@modal.enter()
def load(self) -> None:
    self.recognizer = HuperRecognizer()
```

Update the `/score` route's call site from `self.corrector` to `self.recognizer`:

```python
        @web_app.post("/score")
        async def score(
            audio: UploadFile = File(...),
            canonical_phones: str = Form(...),
            authorization: str | None = Header(None),
        ) -> ScoreResponse:
            try:
                return handle_score_request(
                    self.recognizer,
                    await audio.read(),
                    canonical_phones,
                    authorization,
                    os.environ["PRONUNCIATION_SERVICE_TOKEN"],
                )
            except UnauthorizedError as exc:
                raise HTTPException(status_code=401, detail=str(exc)) from exc
            except InvalidRequestError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            except Exception as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
```

- [ ] **Step 3: Lint and typecheck**

Run: `cd apps/pronunciation-service && uv run ruff check . && uv run ty check .`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add apps/pronunciation-service/modal_app.py
git commit -m "Bake huper29/huper_recognizer into the Modal image, drop the Corrector's deps"
```

---

### Task 6: Update `README.md`

**Files:**
- Modify: `apps/pronunciation-service/README.md`

- [ ] **Step 1: Update the model reference**

Change:

```markdown
Modal-hosted HuPER Corrector service. See
`docs/superpowers/specs/2026-09-05-pronunciation-service-modal-design.md` for the design.
```

to:

```markdown
Modal-hosted pronunciation-scoring service, using `huper29/huper_recognizer` and
Goodness-of-Pronunciation scoring. See
`docs/superpowers/specs/2026-09-05-pronunciation-service-modal-design.md` (original service
scaffolding) and `docs/superpowers/specs/2026-09-08-gop-pronunciation-scoring-design.md` (the
current scoring approach) for the design.
```

Everything else in the file (local dev commands, deploy instructions, secrets) is unchanged — none
of it referenced the Corrector specifically.

- [ ] **Step 2: Commit**

```bash
git add apps/pronunciation-service/README.md
git commit -m "Update pronunciation-service README for the GOP-based scoring design"
```

---

## After this plan

Once deployed, per the spec's "Threshold and known imprecision": watch real session logs for
false-positive patterns (natural reductions being flagged) and either extend
`ACCEPTABLE_REALIZATIONS` for specific recurring patterns, or revisit whether a learned calibration
layer is worth building once real usage data exists to train one against. Neither is part of this
plan.
