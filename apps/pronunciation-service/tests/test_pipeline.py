import wave
from pathlib import Path

import pytest
import torch

from pipeline import (
    _group_into_spans,
    decode_audio,
    load_waveform,
    score_pronunciation,
)
from schemas import CanonicalWord

FIXTURE = Path(__file__).parent / "fixtures" / "sample.webm"


def test_decode_audio_produces_16khz_mono_wav():
    webm_bytes = FIXTURE.read_bytes()

    wav_path = decode_audio(webm_bytes)
    try:
        with wave.open(str(wav_path), "rb") as wav_file:
            assert wav_file.getframerate() == 16000
            assert wav_file.getnchannels() == 1
    finally:
        wav_path.unlink(missing_ok=True)


def test_decode_audio_raises_on_corrupt_input():
    with pytest.raises(RuntimeError, match="ffmpeg decode failed"):
        decode_audio(b"not a real audio file")


def test_load_waveform_reads_the_decoded_wav_file():
    webm_bytes = FIXTURE.read_bytes()
    wav_path = decode_audio(webm_bytes)
    try:
        waveform = load_waveform(wav_path)
        assert waveform.ndim == 1  # mono
        assert len(waveform) > 0
    finally:
        wav_path.unlink(missing_ok=True)


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


def test_group_into_spans_keeps_a_blank_separated_repeat_as_two_spans():
    # Two distinct occurrences of the same phone with a real blank frame between them (e.g. two
    # words meeting at a boundary, "big guy") must stay two spans, not collapse into one just
    # because the token id matches the previous span's — that's the bug this test guards against.
    assert _group_into_spans([0, 5, 0, 5, 0]) == [(5, [1]), (5, [3])]


# A tiny synthetic vocabulary — not real ARPAbet ids — sized just large enough to construct
# hand-picked log-probability rows with a known, predictable GOP outcome per phone. id 0 is
# always blank, matching the real recognizer's convention. Uses the real recognizer's exact
# blank spelling ("<pad>", lowercase) deliberately — this fake vocabulary predates Fix 2's
# NON_PHONE_TOKENS set (which matches the real huper29/huper_recognizer's uppercase "<PAD>") and
# none of these existing tests' fixtures have blank/special tokens competing for "best", so the
# case mismatch is harmless here; see the lowercase-vs-uppercase note on the new deletion/masking
# tests below, which use their own vocabularies with the real, uppercase spelling.
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


def test_score_pronunciation_scores_the_trailing_phone_after_a_blank_separated_repeat():
    # Regression test for the _group_into_spans bug where a blank-separated repeat of the same
    # phone across a word boundary (e.g. "big guy" — B ends "big", B starts "guy") collapsed into
    # one span. That shifted every subsequent canonical phone out of alignment with `spans`, and
    # dropped the trailing phone off the end entirely (silently skipped by the `i >= len(spans)`
    # guard). Uses its own tiny vocabulary — id 0 is blank, matching the real recognizer's
    # convention — sized to a minimal 4-frame recording where the frame count exactly matches the
    # forced-alignment's minimum required length for "B, B, AY" (3 target phones plus one
    # mandatory blank separator between the adjacent duplicate B's), leaving no alignment freedom:
    # frame 0 -> first B, frame 1 -> the mandatory blank, frame 2 -> second B, frame 3 -> AY.
    id2label = {0: "<pad>", 1: "B", 2: "AY", 3: "X"}
    label2id = {label: id_ for id_, label in id2label.items()}

    def row(probs: dict[str, float]) -> list[float]:
        return [probs.get(id2label[i], 1e-9) for i in range(len(id2label))]

    rows = [
        row({"B": 0.97, "AY": 0.01, "X": 0.01, "<pad>": 0.01}),  # frame 0: confidently "big"'s B
        row({"<pad>": 0.97, "B": 0.01, "AY": 0.01, "X": 0.01}),  # frame 1: mandatory blank
        row({"B": 0.97, "AY": 0.01, "X": 0.01, "<pad>": 0.01}),  # frame 2: confidently "guy"'s B
        row({"X": 0.97, "AY": 0.01, "B": 0.01, "<pad>": 0.01}),  # frame 3: mispronounced AY as X
    ]
    log_probs = torch.log(torch.tensor([rows], dtype=torch.float32))

    class _FakeRecognizer:
        def __init__(self) -> None:
            self.label2id = label2id
            self.id2label = id2label

        def log_probs(self, waveform: object) -> torch.Tensor:
            return log_probs

    canonical = [
        CanonicalWord(word="big", phones=["B"]),
        CanonicalWord(word="guy", phones=["B", "AY"]),
    ]

    ops = score_pronunciation(_FakeRecognizer(), None, canonical)

    # Both B's are correctly not flagged (each confidently matches its own span) — only the
    # trailing AY, which the bug used to drop instead of scoring, is reported.
    assert len(ops) == 1
    assert ops[0].word == "guy"
    assert ops[0].wordIndex == 1
    assert ops[0].op == "sub"
    assert ops[0].expectedPhoneme == "AY"
    assert ops[0].spokenPhoneme == "X"


def test_score_pronunciation_returns_empty_list_for_no_canonical_phones():
    # No audio-dependent work should happen at all — recognizer.log_probs is never even called
    # (FakeRecognizer would return the same tensor regardless, so this only really matters once
    # a real recognizer is wired in, but the early return is the behavior under test).
    recognizer = FakeRecognizer(_log_probs_tensor([_row({"D": 0.9})]))

    assert score_pronunciation(recognizer, None, []) == []
    assert score_pronunciation(recognizer, None, [CanonicalWord(word="", phones=[])]) == []


def test_score_pronunciation_raises_for_an_out_of_vocabulary_canonical_phone():
    recognizer = FakeRecognizer(_log_probs_tensor([_row({"D": 0.9})]))
    canonical = [CanonicalWord(word="x", phones=["ZZZ"])]

    with pytest.raises(ValueError, match="ZZZ"):
        score_pronunciation(recognizer, None, canonical)


def test_score_pronunciation_raises_when_audio_is_too_short_for_the_phone_count():
    # One frame of audio, but two canonical phones — forced_align can't place two targets in one
    # frame, so this must fail loudly instead of hitting forced_align's own opaque RuntimeError.
    recognizer = FakeRecognizer(_log_probs_tensor([_row({"D": 0.9})]))
    canonical = [CanonicalWord(word="x", phones=["D", "V"])]

    with pytest.raises(ValueError, match="too short"):
        score_pronunciation(recognizer, None, canonical)


# These two tests use their own local vocabularies with the real recognizer's uppercase special-
# token spelling ("<PAD>", matching NON_PHONE_TOKENS) rather than the shared _ID2LABEL above (which
# uses lowercase "<pad>" and predates the deletion/masking fix — see the note on _ID2LABEL).
_DEL_ID2LABEL = {0: "<PAD>", 1: "D", 2: "DX", 3: "V", 4: "B"}
_DEL_LABEL2ID = {label: id_ for id_, label in _DEL_ID2LABEL.items()}


def _del_row(probs: dict[str, float]) -> list[float]:
    return [probs.get(_DEL_ID2LABEL[i], 1e-9) for i in range(len(_DEL_ID2LABEL))]


class _PadVocabFakeRecognizer:
    """Same shape as FakeRecognizer, but with the real recognizer's uppercase "<PAD>" spelling so
    NON_PHONE_TOKENS actually matches it."""

    def __init__(self, log_probs: torch.Tensor):
        self._log_probs = log_probs
        self.label2id = _DEL_LABEL2ID
        self.id2label = _DEL_ID2LABEL

    def log_probs(self, waveform: object) -> torch.Tensor:
        return self._log_probs


def test_score_pronunciation_reports_a_deletion_when_the_span_is_mostly_non_phone():
    # Single canonical phone "D", 3 frames, all overwhelmingly "<PAD>" (including D's own frame —
    # forced_align must still place D's target somewhere, but every candidate frame's own raw
    # argmax favors <PAD>). Verified against forced_align directly: with 3 frames this uniform,
    # forced_align assigns frames 0-1 to blank and only the last frame to D, and that frame's own
    # raw argmax is still <PAD> (id 0) — 1 of that 1-frame span is non-phone, i.e. 100% > half.
    rows = [_del_row({"<PAD>": 0.97, "D": 0.01, "DX": 0.01, "V": 0.005, "B": 0.005})] * 3
    log_probs = _log_probs_tensor(rows)
    recognizer = _PadVocabFakeRecognizer(log_probs)
    canonical = [CanonicalWord(word="do", phones=["D"])]

    ops = score_pronunciation(recognizer, None, canonical)

    assert len(ops) == 1
    assert ops[0].word == "do"
    assert ops[0].wordIndex == 0
    assert ops[0].op == "del"
    assert ops[0].expectedPhoneme == "D"
    assert ops[0].spokenPhoneme is None


def test_score_pronunciation_masks_non_phone_tokens_when_picking_the_substituted_phone():
    # Single canonical phone "V", 3 frames. Frames 0 and 2 confidently favor the real (wrong)
    # phone "B"; frame 1 (sandwiched between them) narrowly favors "<PAD>" over "V" (0.5 vs 0.499)
    # — its raw argmax is "<PAD>", but not by a wide margin, so forced_align still finds it more
    # profitable overall to fold all 3 frames into one span for "V" (verified directly against
    # forced_align: it returns all three frames aligned to "V") rather than to fold that middle
    # frame into a run of blanks. Only 1 of 3 frames (33%) is non-phone, below the >50% deletion
    # threshold, so this must fall through to substitution scoring — and report "B" (the real,
    # majority competing phone), never "<PAD>", as spokenPhoneme.
    rows = [
        _del_row({"B": 0.9987, "V": 0.001, "<PAD>": 0.0001, "D": 0.00005, "DX": 0.00005}),
        _del_row({"<PAD>": 0.5, "V": 0.499, "B": 0.0005, "D": 0.00025, "DX": 0.00025}),
        _del_row({"B": 0.9987, "V": 0.001, "<PAD>": 0.0001, "D": 0.00005, "DX": 0.00005}),
    ]
    log_probs = _log_probs_tensor(rows)
    recognizer = _PadVocabFakeRecognizer(log_probs)
    canonical = [CanonicalWord(word="very", phones=["V"])]

    ops = score_pronunciation(recognizer, None, canonical)

    assert len(ops) == 1
    assert ops[0].word == "very"
    assert ops[0].wordIndex == 0
    assert ops[0].op == "sub"
    assert ops[0].expectedPhoneme == "V"
    assert ops[0].spokenPhoneme == "B"
