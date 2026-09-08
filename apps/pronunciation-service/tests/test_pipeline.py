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
