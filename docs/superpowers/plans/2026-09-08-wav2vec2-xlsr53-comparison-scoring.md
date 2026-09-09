# wav2vec2-xlsr-53 Parallel Comparison Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `facebook/wav2vec2-xlsr-53-espeak-cv-ft` through the same GOP scoring pipeline as
`huper29/huper_recognizer`, on every `/score` request, logging its result for comparison without
changing what's served to the app.

**Architecture:** `pipeline.py`'s `score_pronunciation` becomes fully recognizer-agnostic (a small
fix — see Task 1). A new `Wav2Vec2XlsrRecognizer` in `models.py` satisfies the same `Recognizer`
protocol `HuperRecognizer` does. A new `arpabet_to_ipa.py` maps `g2p.ts`'s ARPAbet canonical phones
to this model's IPA vocabulary. `handle_score_request` calls `score_pronunciation` a second time
against the new recognizer, inside a broad `try/except` that only logs — the `ScoreResponse` a
caller receives is unchanged.

**Tech Stack:** Python 3.13, `transformers` (`Wav2Vec2FeatureExtractor` + `Wav2Vec2ForCTC`),
`torchaudio.functional.forced_align`, `huggingface_hub`, Modal, pytest.

**Spec:** `docs/superpowers/specs/2026-09-08-wav2vec2-xlsr53-comparison-scoring-design.md`

## Global Constraints

- 100-char line length (`pyproject.toml`'s `[tool.ruff]`).
- `ruff check .` and `ty check .` must pass with zero warnings before every commit.
- No relative imports — this project uses flat top-level modules (`from pipeline import ...`, not
  `from .pipeline import ...`), matching every existing file.
- Google-style docstrings on every public class/function, following this codebase's existing
  "why, not what" comment style (see `pipeline.py`'s `ACCEPTABLE_REALIZATIONS` docstring for the
  house style).
- The `/score` HTTP contract, `schemas.py`, and every TS-side consumer are unchanged — nothing in
  this plan touches `apps/server/`.
- The comparison model's result is logged only, never added to `ScoreResponse` — this is the
  spec's Non-goal, not an implementation detail to relax.

---

## Task 1: Make `NON_PHONE_TOKENS` per-`Recognizer`, not a shared HuPER-shaped constant

**Why this is first:** `score_pronunciation` currently checks `label in NON_PHONE_TOKENS` against a
module-level constant spelled to match HuPER's vocabulary (`"<PAD>"`, `"<UNK>"`, etc.). The new
model's special tokens are different strings entirely (confirmed: its `special_tokens_map.json`
sets `bos_token`/`eos_token`/`unk_token`/`pad_token` all to a single space character). Every later
task needs `score_pronunciation` to ask each recognizer for its own non-phone tokens instead.

**Files:**
- Modify: `apps/pronunciation-service/pipeline.py` (the `Recognizer` Protocol and
  `score_pronunciation`)
- Modify: `apps/pronunciation-service/models.py` (`HuperRecognizer`)
- Modify: `apps/pronunciation-service/tests/test_pipeline.py` (all three fake recognizer classes)

**Interfaces:**
- Produces: `Recognizer.non_phone_tokens: frozenset[str]` — every later `Recognizer`
  implementation (including Task 3's `Wav2Vec2XlsrRecognizer`) must set this.

- [ ] **Step 1: Update the failing tests first**

In `tests/test_pipeline.py`, every fake recognizer class needs a `non_phone_tokens` attribute —
`score_pronunciation` will unconditionally read `recognizer.non_phone_tokens` once Step 3 lands, so
these tests fail with `AttributeError` until this step, which is the point (red before green).

Add `self.non_phone_tokens = frozenset({"<pad>"})` to `FakeRecognizer.__init__` (matches that
class's existing lowercase `"<pad>"` vocab entry in `_ID2LABEL`):

```python
class FakeRecognizer:
    """Satisfies pipeline.Recognizer without loading any real model — returns a pre-built
    log-probability tensor regardless of the waveform it's given."""

    def __init__(self, log_probs: torch.Tensor):
        self._log_probs = log_probs
        self.label2id = _LABEL2ID
        self.id2label = _ID2LABEL
        self.non_phone_tokens = frozenset({"<pad>"})

    def log_probs(self, waveform: object) -> torch.Tensor:
        return self._log_probs
```

Add the same to the local `_FakeRecognizer` class inside
`test_score_pronunciation_scores_the_trailing_phone_after_a_blank_separated_repeat` (its vocab also
uses lowercase `"<pad>"`):

```python
    class _FakeRecognizer:
        def __init__(self) -> None:
            self.label2id = label2id
            self.id2label = id2label
            self.non_phone_tokens = frozenset({"<pad>"})

        def log_probs(self, waveform: object) -> torch.Tensor:
            return log_probs
```

Add `non_phone_tokens = frozenset({"<PAD>"})` (uppercase, matching `_DEL_ID2LABEL`) to
`_PadVocabFakeRecognizer.__init__`:

```python
class _PadVocabFakeRecognizer:
    """Same shape as FakeRecognizer, but with the real recognizer's uppercase "<PAD>" spelling so
    non_phone_tokens actually matches it."""

    def __init__(self, log_probs: torch.Tensor):
        self._log_probs = log_probs
        self.label2id = _DEL_LABEL2ID
        self.id2label = _DEL_ID2LABEL
        self.non_phone_tokens = frozenset({"<PAD>"})

    def log_probs(self, waveform: object) -> torch.Tensor:
        return self._log_probs
```

- [ ] **Step 2: Run the full test suite to confirm nothing fails yet**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_pipeline.py -v`
Expected: PASS — adding an unused attribute doesn't break anything yet; this just confirms the test
file edits above didn't introduce a syntax error before the real behavior change.

- [ ] **Step 3: Update `pipeline.py`'s `Recognizer` protocol and `score_pronunciation`**

Remove the module-level `NON_PHONE_TOKENS` constant and its docstring comment entirely. Add
`non_phone_tokens` to the `Recognizer` Protocol:

```python
class Recognizer(Protocol):
    """What score_pronunciation needs from a phone-recognition model — satisfied structurally by
    models.py's HuperRecognizer and Wav2Vec2XlsrRecognizer, with no inheritance relationship
    required."""

    label2id: dict[str, int]
    id2label: dict[int, str]
    non_phone_tokens: frozenset[str]

    def log_probs(self, waveform) -> torch.Tensor:
        """Returns log-softmax'd per-frame class log-probabilities, shape (1, T, C)."""
        ...
```

Change the one call site inside `score_pronunciation` from the module constant to the recognizer's
own attribute:

```python
    non_phone_ids = [
        id_ for id_, label in recognizer.id2label.items() if label in recognizer.non_phone_tokens
    ]
```

- [ ] **Step 4: Add `non_phone_tokens` to `HuperRecognizer`**

In `models.py`, add the class attribute carrying exactly the value the old module constant held —
this is a pure move, not a behavior change for the HuPER path:

```python
class HuperRecognizer:
    """Wraps huper29/huper_recognizer, a standard `transformers` WavLM-Large CTC phone recognizer —
    unlike the HuPER Corrector this replaces, no bespoke `edit_seq_speech` package or sys.path
    hack is needed; it's loadable through `transformers` alone.
    """

    # Non-phone classes in HuPER's vocabulary (blank/padding and other special CTC tokens). A span
    # where these dominate the per-frame argmax is the recognizer's honest signal that nothing was
    # really articulated there, not a real (mispronounced) phone — see score_pronunciation's
    # deletion check. Every Recognizer implementation declares its own — this set is specific to
    # HuPER's vocabulary spelling and must not be assumed to match any other model's.
    non_phone_tokens: frozenset[str] = frozenset({"<PAD>", "<UNK>", "<BOS>", "<EOS>", "|"})

    def __init__(self, repo_id: str = "huper29/huper_recognizer") -> None:
        ...  # unchanged
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_pipeline.py -v`
Expected: PASS — all existing tests green, including the deletion/masking tests, now reading
`non_phone_tokens` off each fake recognizer instead of a shared constant.

- [ ] **Step 6: Lint and typecheck**

Run: `cd apps/pronunciation-service && uv run ruff check . && uv run ty check .`
Expected: zero warnings.

- [ ] **Step 7: Commit**

```bash
cd apps/pronunciation-service
git add pipeline.py models.py tests/test_pipeline.py
git commit -m "Make non_phone_tokens per-Recognizer instead of a HuPER-shaped constant"
```

---

## Task 2: `arpabet_to_ipa.py` — the ARPAbet→IPA phone-mapping table

**Files:**
- Create: `apps/pronunciation-service/arpabet_to_ipa.py`
- Test: `apps/pronunciation-service/tests/test_arpabet_to_ipa.py`

**Interfaces:**
- Consumes: `schemas.CanonicalWord`
- Produces: `to_ipa_phones(canonical_phones: list[CanonicalWord]) -> list[CanonicalWord]` — Task 4
  calls this before passing canonical phones to the comparison recognizer's
  `score_pronunciation` call.

**Why every entry is a single symbol, not a two-phone expansion:** the design spec anticipated
possibly needing to expand ARPAbet diphthongs (`AY`, `AW`, `EY`, `OW`, `OY`) into two IPA phones,
since IPA in general has no single symbol for a diphthong. Checking this model's actual
`vocab.json` (`facebook/wav2vec2-xlsr-53-espeak-cv-ft`) resolves that question: it already has
dedicated single-token symbols for every one of these (`aɪ`, `aʊ`, `eɪ`, `oʊ`, `ɔɪ` all appeared
directly in this project's own local spike decodes of real audio). So the mapping table below is a
plain 1:1 dict — no `CanonicalWord.phones` length changes, no `word_positions` bookkeeping concerns.

- [ ] **Step 1: Write the failing tests**

```python
import pytest

from arpabet_to_ipa import to_ipa_phones
from schemas import CanonicalWord


def test_to_ipa_phones_maps_a_plain_consonant_and_vowel():
    canonical = [CanonicalWord(word="dog", phones=["D", "AA", "G"])]

    result = to_ipa_phones(canonical)

    assert result == [CanonicalWord(word="dog", phones=["d", "ɑː", "ɡ"])]


def test_to_ipa_phones_maps_a_diphthong_to_its_single_ipa_symbol():
    # AY has a dedicated single-token IPA symbol in this vocabulary (aɪ) — not a two-phone
    # onset/offset expansion, confirmed against the model's own vocab.json.
    canonical = [CanonicalWord(word="high", phones=["HH", "AY"])]

    result = to_ipa_phones(canonical)

    assert result == [CanonicalWord(word="high", phones=["h", "aɪ"])]


def test_to_ipa_phones_maps_r_to_the_english_approximant_not_the_trill():
    # The canonical/expected phone must be the standard American English approximant ɹ — the
    # entire point of this comparison model is noticing when the audio's actual phone is the
    # "wrong" trill/tap/uvular alternative instead. Confirmed against this model's own vocab.json:
    # ɹ and r (trill) are separate symbols.
    canonical = [CanonicalWord(word="red", phones=["R", "EH", "D"])]

    result = to_ipa_phones(canonical)

    assert result[0].phones[0] == "ɹ"


def test_to_ipa_phones_preserves_word_boundaries_across_multiple_words():
    canonical = [
        CanonicalWord(word="hi", phones=["HH", "AY"]),
        CanonicalWord(word="there", phones=["DH", "EH", "R"]),
    ]

    result = to_ipa_phones(canonical)

    assert [w.word for w in result] == ["hi", "there"]
    assert result[1].phones == ["ð", "ɛ", "ɹ"]


def test_to_ipa_phones_handles_a_word_with_no_phones():
    canonical = [CanonicalWord(word="", phones=[])]

    assert to_ipa_phones(canonical) == [CanonicalWord(word="", phones=[])]


def test_to_ipa_phones_raises_for_a_phone_not_in_the_table():
    canonical = [CanonicalWord(word="x", phones=["ZZZ"])]

    with pytest.raises(ValueError, match="ZZZ"):
        to_ipa_phones(canonical)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_arpabet_to_ipa.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'arpabet_to_ipa'`

- [ ] **Step 3: Implement `arpabet_to_ipa.py`**

```python
from schemas import CanonicalWord

# Every ARPAbet phone g2p.ts's HUPER_VALID_PHONES set may produce (see
# apps/server/src/g2p.ts), plus DX (the flap allophone HuPER's own output vocabulary includes even
# though g2p never targets it directly — see pipeline.py's ACCEPTABLE_REALIZATIONS), mapped to its
# corresponding symbol in facebook/wav2vec2-xlsr-53-espeak-cv-ft's IPA vocabulary. Verified against
# that model's actual vocab.json, not assumed from general IPA knowledge. Every entry is a single
# symbol — this vocabulary already has dedicated single-token symbols for every English diphthong
# ARPAbet uses, so no two-phone onset/offset expansion is needed.
ARPABET_TO_IPA: dict[str, str] = {
    "AA": "ɑː",
    "AE": "æ",
    # g2p.ts strips stress digits, so AH covers both the stressed vowel /ʌ/ and the reduced vowel
    # /ə/ — /ʌ/ is AH's primary (citation-form) identity, chosen as the single mapping here.
    "AH": "ʌ",
    "AW": "aʊ",
    "AY": "aɪ",
    "B": "b",
    "CH": "tʃ",
    "D": "d",
    "DH": "ð",
    "DX": "ɾ",
    "EH": "ɛ",
    "ER": "ɚ",
    "EY": "eɪ",
    "F": "f",
    "G": "ɡ",
    "HH": "h",
    "IH": "ɪ",
    "IY": "iː",
    "JH": "dʒ",
    "K": "k",
    "L": "l",
    "M": "m",
    "N": "n",
    "NG": "ŋ",
    "OW": "oʊ",
    "OY": "ɔɪ",
    "P": "p",
    # The canonical English approximant, not the trill "r" — see this module's docstring on
    # to_ipa_phones and the test above for why this direction matters.
    "R": "ɹ",
    "S": "s",
    "SH": "ʃ",
    "T": "t",
    "TH": "θ",
    "UH": "ʊ",
    "UW": "uː",
    "V": "v",
    "W": "w",
    "Y": "j",
    "Z": "z",
    "ZH": "ʒ",
}


def to_ipa_phones(canonical_phones: list[CanonicalWord]) -> list[CanonicalWord]:
    """Rewrites each word's ARPAbet phones into facebook/wav2vec2-xlsr-53-espeak-cv-ft's IPA
    symbols, for scoring canonical phones against that model instead of HuPER. Raises ValueError
    on any phone absent from ARPABET_TO_IPA, matching score_pronunciation's own fail-loud
    convention for out-of-vocabulary phones rather than silently dropping or passing one through.
    """
    mapped = []
    for word in canonical_phones:
        ipa_phones = []
        for phone in word.phones:
            if phone not in ARPABET_TO_IPA:
                raise ValueError(f"no IPA mapping for ARPAbet phone {phone!r}")
            ipa_phones.append(ARPABET_TO_IPA[phone])
        mapped.append(CanonicalWord(word=word.word, phones=ipa_phones))
    return mapped
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_arpabet_to_ipa.py -v`
Expected: PASS

- [ ] **Step 5: Lint and typecheck**

Run: `cd apps/pronunciation-service && uv run ruff check . && uv run ty check .`
Expected: zero warnings.

- [ ] **Step 6: Commit**

```bash
cd apps/pronunciation-service
git add arpabet_to_ipa.py tests/test_arpabet_to_ipa.py
git commit -m "Add ARPAbet-to-IPA phone mapping for the comparison recognizer"
```

---

## Task 3: `Wav2Vec2XlsrRecognizer` in `models.py`

**Files:**
- Modify: `apps/pronunciation-service/models.py`
- Create (throwaway, not committed): a local smoke-test script, run manually — see Step 4. This
  project has no existing unit-test coverage for `HuperRecognizer` either (it requires a real model
  download and GPU/CPU inference, which the codebase's own testing convention deliberately keeps
  out of the `pytest` suite — see `tests/test_pipeline.py`'s fake-recognizer pattern). This task
  follows that same precedent: `Wav2Vec2XlsrRecognizer` itself isn't unit tested, but is verified
  end-to-end against real audio before being wired into `handler.py` in Task 4.

**Interfaces:**
- Produces: `Wav2Vec2XlsrRecognizer` — a class satisfying `pipeline.Recognizer`
  (`label2id: dict[str, int]`, `id2label: dict[int, str]`, `non_phone_tokens: frozenset[str]`,
  `log_probs(waveform) -> torch.Tensor`). Task 4 and Task 5 both instantiate this.

- [ ] **Step 1: Verify the vocab-loading approach against the real model, before writing it into `models.py`**

This model's special tokens (`bos`/`eos`/`unk`/`pad`) all display as a single space character in
`special_tokens_map.json` — whether they're four genuinely distinct Unicode strings or would
collapse under naive JSON parsing is not yet confirmed. Run this locally (in
`apps/pronunciation-service`'s `uv` environment, or a scratch venv) before writing the real
implementation:

```python
import json
from huggingface_hub import hf_hub_download

vocab_path = hf_hub_download("facebook/wav2vec2-xlsr-53-espeak-cv-ft", "vocab.json")
with open(vocab_path) as f:
    label2id = json.load(f)

print(f"total entries: {len(label2id)}")  # must be 392 — if fewer, some special-token keys
                                            # collapsed during JSON parsing and Step 3 below needs
                                            # a different approach (e.g. reading tokenizer_config's
                                            # added_tokens_decoder instead of raw vocab.json).
for label, id_ in sorted(label2id.items(), key=lambda kv: kv[1])[:4]:
    print(repr(label), id_)  # inspect the real codepoints for ids 0-3, don't assume they're " "
```

Also confirm the model loads without `phonemizer` installed (uninstall it from the scratch venv
first if present from the earlier spike venv) using only the feature extractor and CTC model:

```python
from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC

fe = Wav2Vec2FeatureExtractor.from_pretrained("facebook/wav2vec2-xlsr-53-espeak-cv-ft")
model = Wav2Vec2ForCTC.from_pretrained("facebook/wav2vec2-xlsr-53-espeak-cv-ft")
print(model.config.pad_token_id, model.config.bos_token_id, model.config.eos_token_id)
```

If this raises (e.g. `Wav2Vec2FeatureExtractor.from_pretrained` unexpectedly needs the tokenizer
too), fall back to loading via the full `Wav2Vec2Processor` instead (as the earlier spike did) and
add `phonemizer` + an `espeak-ng` system package to `modal_app.py`'s image in Task 5 — note which
path was needed when writing Task 5's dependency list.

- [ ] **Step 2: Implement `Wav2Vec2XlsrRecognizer`**

Append to `models.py`, after the existing `HuperRecognizer` class:

```python
class Wav2Vec2XlsrRecognizer:
    """Wraps facebook/wav2vec2-xlsr-53-espeak-cv-ft for comparison-only scoring (see
    docs/superpowers/specs/2026-09-08-wav2vec2-xlsr53-comparison-scoring-design.md) — loads only
    the feature extractor and CTC model, not the full Wav2Vec2Processor, to avoid that class's
    Wav2Vec2PhonemeCTCTokenizer pulling in the `phonemizer` package and an `espeak-ng` binary this
    use case never needs (only score_pronunciation's log-probs-based scoring is used here, never
    phonemizer's text-to-phoneme encoding).
    """

    def __init__(self, repo_id: str = "facebook/wav2vec2-xlsr-53-espeak-cv-ft") -> None:
        import json

        import torch
        from huggingface_hub import hf_hub_download
        from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC

        self.feature_extractor = Wav2Vec2FeatureExtractor.from_pretrained(repo_id)
        self.model = Wav2Vec2ForCTC.from_pretrained(repo_id)
        self.model.eval()
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model.to(self.device)

        vocab_path = hf_hub_download(repo_id, "vocab.json")
        with open(vocab_path) as f:
            self.label2id: dict[str, int] = json.load(f)
        self.id2label: dict[int, str] = {id_: label for label, id_ in self.label2id.items()}

        # Derived from the model's own config rather than hardcoding the special tokens' literal
        # string content (bos/eos/unk/pad all happen to display as a plain space character, but
        # whether they're identical or distinct Unicode strings isn't assumed here — reading them
        # back out through id2label is correct regardless).
        non_phone_ids = {
            self.model.config.pad_token_id,
            self.model.config.bos_token_id,
            self.model.config.eos_token_id,
        }
        self.non_phone_tokens: frozenset[str] = frozenset(
            self.id2label[id_] for id_ in non_phone_ids if id_ in self.id2label
        )

    def log_probs(self, waveform):
        """Returns log-softmax'd per-frame class log-probabilities for a 16kHz mono waveform,
        shape (1, T, C)."""
        import torch
        import torch.nn.functional as F

        inputs = self.feature_extractor(waveform, sampling_rate=16000, return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with torch.no_grad():
            logits = self.model(**inputs).logits
        return F.log_softmax(logits, dim=-1).cpu()
```

- [ ] **Step 3: Smoke-test against real audio (not committed, throwaway per this task's own note above)**

Run from a scratch script (mirroring the local spike already run during this feature's design
investigation):

```python
import soundfile as sf
from models import Wav2Vec2XlsrRecognizer
from arpabet_to_ipa import to_ipa_phones
from schemas import CanonicalWord
from pipeline import score_pronunciation

recognizer = Wav2Vec2XlsrRecognizer()
waveform, sr = sf.read("apps/server/pronunciation-scorer-test/rock-red-arrow-try-spanish.mp3", dtype="float32")
assert sr == 16000  # decode via ffmpeg first if not — see pipeline.py's decode_audio/load_waveform

canonical = to_ipa_phones([
    CanonicalWord(word="rock", phones=["R", "AA", "K"]),
    CanonicalWord(word="red", phones=["R", "EH", "D"]),
    CanonicalWord(word="arrow", phones=["EH", "R", "OW"]),
    CanonicalWord(word="try", phones=["T", "R", "AY"]),
])
ops = score_pronunciation(recognizer, waveform, canonical)
for op in ops:
    print(op)
```

Expected: at least one `sub` op with `expectedPhoneme="ɹ"` and `spokenPhoneme` in the trill/tap
family (`r`/`ɾ`/`ʁ`), reproducing the rhotic-substitution finding from this feature's local spike
now through the actual `score_pronunciation`/GOP path, not just raw argmax inspection.

- [ ] **Step 4: Lint and typecheck**

Run: `cd apps/pronunciation-service && uv run ruff check . && uv run ty check .`
Expected: zero warnings.

- [ ] **Step 5: Commit**

```bash
cd apps/pronunciation-service
git add models.py
git commit -m "Add Wav2Vec2XlsrRecognizer for comparison scoring"
```

---

## Task 4: Wire the comparison call into `handle_score_request`

**Files:**
- Modify: `apps/pronunciation-service/handler.py`
- Modify: `apps/pronunciation-service/tests/test_handler.py`

**Interfaces:**
- Consumes: `Wav2Vec2XlsrRecognizer` (Task 3), `to_ipa_phones` (Task 2), `score_pronunciation`
  (unchanged from Task 1's fix)
- Produces: `handle_score_request`'s new signature — Task 5's `modal_app.py` must pass both
  recognizers in the new parameter order.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_handler.py` (the existing tests all pass `object()` as the sole recognizer
argument — they need a second `object()` for the new parameter, since they exercise the
auth/parsing short-circuits that raise before any recognizer is touched):

```python
def test_handle_score_request_rejects_a_missing_bearer_token():
    with pytest.raises(UnauthorizedError):
        handle_score_request(
            object(),  # ty: ignore[invalid-argument-type]
            object(),  # ty: ignore[invalid-argument-type]
            b"audio",
            CANONICAL_JSON,
            None,
            "secret-token",
        )


def test_handle_score_request_rejects_a_wrong_bearer_token():
    with pytest.raises(UnauthorizedError):
        handle_score_request(
            object(),  # ty: ignore[invalid-argument-type]
            object(),  # ty: ignore[invalid-argument-type]
            b"audio",
            CANONICAL_JSON,
            "Bearer wrong-token",
            "secret-token",
        )


def test_handle_score_request_rejects_malformed_canonical_phones_json():
    with pytest.raises(InvalidRequestError):
        handle_score_request(
            object(),  # ty: ignore[invalid-argument-type]
            object(),  # ty: ignore[invalid-argument-type]
            b"audio",
            "not json",
            "Bearer secret-token",
            "secret-token",
        )


def test_handle_score_request_rejects_canonical_phones_missing_required_fields():
    with pytest.raises(InvalidRequestError):
        handle_score_request(
            object(),  # ty: ignore[invalid-argument-type]
            object(),  # ty: ignore[invalid-argument-type]
            b"audio",
            json.dumps([{"word": "hi"}]),
            "Bearer secret-token",
            "secret-token",
        )
```

Update the success-path test and add two new ones:

```python
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
    monkeypatch.setattr("handler.to_ipa_phones", lambda words: words)

    result = handle_score_request(
        object(),  # ty: ignore[invalid-argument-type]
        object(),  # ty: ignore[invalid-argument-type]
        b"audio",
        CANONICAL_JSON,
        "Bearer secret-token",
        "secret-token",
    )

    assert isinstance(result, ScoreResponse)
    assert len(result.editOps) == 1
    assert result.editOps[0].op == "sub"
    assert result.editOps[0].expectedPhoneme == "AY"
    assert result.editOps[0].spokenPhoneme == "EY"


def test_handle_score_request_still_succeeds_when_the_comparison_scorer_raises(monkeypatch, caplog):
    monkeypatch.setattr("handler.decode_audio", lambda _audio_bytes: Path("/tmp/turn.wav"))
    monkeypatch.setattr("handler.load_waveform", lambda _wav_path: object())
    monkeypatch.setattr("handler.to_ipa_phones", lambda words: words)

    call_count = 0

    def fake_score_pronunciation(_recognizer, _waveform, _words):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return [
                PronunciationEditOp(
                    word="hi", wordIndex=0, op="sub", expectedPhoneme="AY", spokenPhoneme="EY"
                )
            ]
        raise RuntimeError("comparison model exploded")

    monkeypatch.setattr("handler.score_pronunciation", fake_score_pronunciation)

    result = handle_score_request(
        object(),  # ty: ignore[invalid-argument-type]
        object(),  # ty: ignore[invalid-argument-type]
        b"audio",
        CANONICAL_JSON,
        "Bearer secret-token",
        "secret-token",
    )

    # The served response is exactly what the first (HuPER) call produced — the second
    # (comparison) call's failure never reaches the caller.
    assert isinstance(result, ScoreResponse)
    assert len(result.editOps) == 1
    assert result.editOps[0].spokenPhoneme == "EY"
    assert "comparison model exploded" in caplog.text


def test_handle_score_request_logs_the_comparison_scorer_result_on_success(monkeypatch, caplog):
    monkeypatch.setattr("handler.decode_audio", lambda _audio_bytes: Path("/tmp/turn.wav"))
    monkeypatch.setattr("handler.load_waveform", lambda _wav_path: object())
    monkeypatch.setattr("handler.to_ipa_phones", lambda words: words)
    monkeypatch.setattr(
        "handler.score_pronunciation",
        lambda _recognizer, _waveform, _words: [
            PronunciationEditOp(
                word="red", wordIndex=0, op="sub", expectedPhoneme="ɹ", spokenPhoneme="r"
            )
        ],
    )

    with caplog.at_level("INFO"):
        handle_score_request(
            object(),  # ty: ignore[invalid-argument-type]
            object(),  # ty: ignore[invalid-argument-type]
            b"audio",
            CANONICAL_JSON,
            "Bearer secret-token",
            "secret-token",
        )

    assert "comparison scoring" in caplog.text
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_handler.py -v`
Expected: FAIL — `handle_score_request()` doesn't yet accept a second positional recognizer
argument (`TypeError: handle_score_request() takes ... positional arguments but ... were given`).

- [ ] **Step 3: Update `handler.py`**

```python
import json
import logging

from pydantic import ValidationError

from arpabet_to_ipa import to_ipa_phones
from pipeline import Recognizer, decode_audio, load_waveform, score_pronunciation
from schemas import CanonicalWord, ScoreResponse

logger = logging.getLogger(__name__)


class UnauthorizedError(Exception):
    pass


class InvalidRequestError(Exception):
    pass


def handle_score_request(
    recognizer: Recognizer,
    comparison_recognizer: Recognizer,
    audio_bytes: bytes,
    canonical_phones_json: str,
    authorization: str | None,
    expected_token: str,
) -> ScoreResponse:
    """Runs the full `/score` request: auth check, request parsing, the decode/score pipeline
    against `recognizer` (served in the response), a second decode/score pass against
    `comparison_recognizer` (logged only — see
    docs/superpowers/specs/2026-09-08-wav2vec2-xlsr53-comparison-scoring-design.md), and response
    construction. Framework-agnostic — the caller (`modal_app.py`) translates the exceptions raised
    here to HTTP status codes.
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

        try:
            comparison_ops = score_pronunciation(
                comparison_recognizer, waveform, to_ipa_phones(words)
            )
            logger.info("comparison scoring: %s", comparison_ops)
        except Exception:
            logger.exception("comparison scoring failed")
    finally:
        wav_path.unlink(missing_ok=True)

    return ScoreResponse(editOps=edit_ops)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/pronunciation-service && uv run pytest tests/test_handler.py -v`
Expected: PASS

- [ ] **Step 5: Run the full test suite**

Run: `cd apps/pronunciation-service && uv run pytest -v`
Expected: PASS, all files.

- [ ] **Step 6: Lint and typecheck**

Run: `cd apps/pronunciation-service && uv run ruff check . && uv run ty check .`
Expected: zero warnings.

- [ ] **Step 7: Commit**

```bash
cd apps/pronunciation-service
git add handler.py tests/test_handler.py
git commit -m "Score every turn against the comparison recognizer, logged only"
```

---

## Task 5: Wire both recognizers into `modal_app.py`, deploy, and verify against the live service

**Files:**
- Modify: `apps/pronunciation-service/modal_app.py`

**Interfaces:**
- Consumes: `Wav2Vec2XlsrRecognizer` (Task 3), `handle_score_request`'s new signature (Task 4)

- [ ] **Step 1: Add the download step and update the image**

```python
import os

import modal
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

from handler import InvalidRequestError, UnauthorizedError, handle_score_request
from models import HuperRecognizer, Wav2Vec2XlsrRecognizer
from schemas import ScoreResponse


def _download_recognizer() -> None:
    # ty: ignore[unresolved-import] -- only installed inside the Modal image, not the local venv
    from transformers import Wav2Vec2Processor, WavLMForCTC

    Wav2Vec2Processor.from_pretrained("huper29/huper_recognizer")
    WavLMForCTC.from_pretrained("huper29/huper_recognizer")


def _download_comparison_recognizer() -> None:
    # ty: ignore[unresolved-import] -- only installed inside the Modal image, not the local venv
    from huggingface_hub import hf_hub_download
    from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC

    repo_id = "facebook/wav2vec2-xlsr-53-espeak-cv-ft"
    Wav2Vec2FeatureExtractor.from_pretrained(repo_id)
    Wav2Vec2ForCTC.from_pretrained(repo_id)
    hf_hub_download(repo_id, "vocab.json")


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
    .add_local_python_source("arpabet_to_ipa", "handler", "models", "pipeline", "schemas", copy=True)
    .run_function(_download_recognizer)
    .run_function(_download_comparison_recognizer)
)

app = modal.App("kalli-pronunciation-service", image=image)
auth_secret = modal.Secret.from_name("pronunciation-service-auth")


@app.cls(gpu="T4", secrets=[auth_secret], min_containers=0)
class PronunciationService:
    @modal.enter()
    def load(self) -> None:
        self.recognizer = HuperRecognizer()
        self.comparison_recognizer = Wav2Vec2XlsrRecognizer()

    @modal.asgi_app()
    def web(self) -> FastAPI:
        # @modal.fastapi_endpoint has no path parameter - it always serves at the URL root, which
        # doesn't match the already-shipped TS adapter's fixed `POST {url}/score` contract. A
        # manually-built FastAPI app under @modal.asgi_app lets /score be an explicit route instead
        # of changing that contract to fit the decorator's default.
        web_app = FastAPI()

        @web_app.post("/score")
        async def score(
            audio: UploadFile = File(...),
            canonical_phones: str = Form(...),
            authorization: str | None = Header(None),
        ) -> ScoreResponse:
            try:
                return handle_score_request(
                    self.recognizer,
                    self.comparison_recognizer,
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

        return web_app
```

If Task 3's Step 1 verification found that `Wav2Vec2FeatureExtractor`-only loading doesn't work
without the full `Wav2Vec2Processor`, add `"phonemizer"` to the `pip_install` list above and
`.apt_install("ffmpeg", "espeak-ng")` instead of just `"ffmpeg"`, and update
`_download_comparison_recognizer` and `Wav2Vec2XlsrRecognizer.__init__` (Task 3) to use
`Wav2Vec2Processor.from_pretrained` instead of the feature-extractor-only path.

- [ ] **Step 2: Run the full local test suite one more time**

Run: `cd apps/pronunciation-service && uv run pytest -v`
Expected: PASS. (`modal_app.py` itself has no test file, consistent with this codebase's existing
pattern — it's deployment glue, verified by deploying, not by pytest.)

- [ ] **Step 3: Lint and typecheck**

Run: `cd apps/pronunciation-service && uv run ruff check . && uv run ty check .`
Expected: zero warnings.

- [ ] **Step 4: Deploy**

Run: `cd apps/pronunciation-service && uv run modal deploy modal_app.py`
Expected: deploy succeeds, both `_download_recognizer` and `_download_comparison_recognizer` run
during the image build (watch the build log for both).

- [ ] **Step 5: Verify against the live service with real audio**

From `apps/server`:

```bash
pnpm run score-audio-file apps/server/pronunciation-scorer-test/rock-red-arrow-try-spanish.mp3 "rock red arrow try"
```

Expected: the served `ScoreResponse` is unchanged from before this plan (still HuPER's result
only). Then check the Modal service's logs (`uv run modal app logs kalli-pronunciation-service`,
or the Modal dashboard) for this same request — expect a `comparison scoring: [...]` log line
containing a `sub` op with `expectedPhoneme="ɹ"` and `spokenPhoneme` in the trill/tap family,
confirming the comparison path is live end-to-end, not just locally smoke-tested.

Also note the wall-clock time `scoreAudioFile.ts` reports for this request (or time the `pnpm run`
invocation directly) and compare it against `SCORE_TURN_TIMEOUT_MS` (10s,
`apps/server/src/pronunciation.ts`) — the spec flagged this as worth measuring, not optimizing,
given HuPER's own cold-start behavior already sometimes approaches that timeout with one model
running. If a warm-container request comes in close to or over 10s with both models running now,
flag it back to the design rather than silently shipping a latency regression — raising
`SCORE_TURN_TIMEOUT_MS` or moving to the fire-and-forget path the spec's Non-goals set aside are
both real options at that point, but neither is this plan's call to make unilaterally.

- [ ] **Step 6: Commit**

```bash
cd apps/pronunciation-service
git add modal_app.py
git commit -m "Deploy the comparison recognizer alongside HuPER"
```

---

## Task 6: Update `README.md`

**Files:**
- Modify: `apps/pronunciation-service/README.md`

- [ ] **Step 1: Add a section describing the comparison scorer**

Insert after the existing intro paragraph:

```markdown
Since 2026-09-08, every scored turn is also scored against
`facebook/wav2vec2-xlsr-53-espeak-cv-ft` for comparison — logged only, never served to the app. See
`docs/superpowers/specs/2026-09-08-wav2vec2-xlsr53-comparison-scoring-design.md` for why.
```

- [ ] **Step 2: Commit**

```bash
cd apps/pronunciation-service
git add README.md
git commit -m "Document the comparison scorer in the README"
```

## After this plan

Per the spec's Non-goals: watch the comparison logs from real sessions for the narrowed set of
still-open contrasts (rhotic realizations confirmed; retroflex-for-alveolar substitutions,
dark/light-L, and aspiration contrasts plausible but not yet spiked individually). Deciding whether
to serve this data, persist it, or eventually replace HuPER is explicitly out of scope here — this
plan only gets the comparison signal flowing and observable in logs.
