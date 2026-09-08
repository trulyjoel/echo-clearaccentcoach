import wave
from pathlib import Path

import pytest
import torch

from pipeline import (
    _group_into_spans,
    decode_audio,
    run_corrector,
    score_pronunciation,
    to_edit_ops,
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


CANONICAL = [
    CanonicalWord(word="he", phones=["HH", "IY"]),
    CanonicalWord(word="likes", phones=["L", "AY", "K", "S"]),
]


def test_to_edit_ops_maps_a_clean_substitution():
    log = [
        {"src": "HH", "op": "KEEP", "ins": "<NONE>"},
        {"src": "IY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "L", "op": "SUB:R", "ins": "<NONE>"},
        {"src": "AY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "K", "op": "KEEP", "ins": "<NONE>"},
        {"src": "S", "op": "KEEP", "ins": "<NONE>"},
    ]

    result = to_edit_ops(log, CANONICAL)

    assert len(result) == 1
    assert result[0].word == "likes"
    assert result[0].wordIndex == 1
    assert result[0].op == "sub"
    assert result[0].expectedPhoneme == "L"
    assert result[0].spokenPhoneme == "R"


def test_to_edit_ops_maps_a_deletion_with_null_spoken_phoneme():
    log = [
        {"src": "HH", "op": "DEL", "ins": "<NONE>"},
        {"src": "IY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "L", "op": "KEEP", "ins": "<NONE>"},
        {"src": "AY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "K", "op": "KEEP", "ins": "<NONE>"},
        {"src": "S", "op": "KEEP", "ins": "<NONE>"},
    ]

    result = to_edit_ops(log, CANONICAL)

    assert len(result) == 1
    assert result[0].word == "he"
    assert result[0].wordIndex == 0
    assert result[0].op == "del"
    assert result[0].expectedPhoneme == "HH"
    assert result[0].spokenPhoneme is None


def test_to_edit_ops_maps_an_insertion_with_null_expected_phoneme():
    log = [
        {"src": "HH", "op": "KEEP", "ins": "<NONE>"},
        {"src": "IY", "op": "KEEP", "ins": "AH"},
        {"src": "L", "op": "KEEP", "ins": "<NONE>"},
        {"src": "AY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "K", "op": "KEEP", "ins": "<NONE>"},
        {"src": "S", "op": "KEEP", "ins": "<NONE>"},
    ]

    result = to_edit_ops(log, CANONICAL)

    assert len(result) == 1
    assert result[0].word == "he"
    assert result[0].op == "ins"
    assert result[0].expectedPhoneme is None
    assert result[0].spokenPhoneme == "AH"


def test_to_edit_ops_produces_two_entries_for_a_substitution_with_a_trailing_insertion():
    log = [
        {"src": "HH", "op": "KEEP", "ins": "<NONE>"},
        {"src": "IY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "L", "op": "SUB:R", "ins": "AH"},
        {"src": "AY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "K", "op": "KEEP", "ins": "<NONE>"},
        {"src": "S", "op": "KEEP", "ins": "<NONE>"},
    ]

    result = to_edit_ops(log, CANONICAL)

    assert len(result) == 2
    assert {(op.op, op.wordIndex) for op in result} == {("sub", 1), ("ins", 1)}


def test_to_edit_ops_ignores_pad_positions():
    log = [
        {"src": "HH", "op": "SUB:<PAD>", "ins": "<PAD>"},
        {"src": "IY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "L", "op": "KEEP", "ins": "<NONE>"},
        {"src": "AY", "op": "KEEP", "ins": "<NONE>"},
        {"src": "K", "op": "KEEP", "ins": "<NONE>"},
        {"src": "S", "op": "KEEP", "ins": "<NONE>"},
    ]

    result = to_edit_ops(log, CANONICAL)

    assert result == []


def test_to_edit_ops_raises_on_log_length_mismatch():
    with pytest.raises(ValueError, match="does not match"):
        to_edit_ops([{"src": "HH", "op": "KEEP", "ins": "<NONE>"}], CANONICAL)


class FakeCorrector:
    def __init__(self):
        self.calls: list[tuple[str, str]] = []

    def predict(self, wav_path: str, text: str) -> tuple[list[str], list[dict]]:
        self.calls.append((wav_path, text))
        return (["HH", "IY"], [{"src": "HH", "op": "KEEP", "ins": "<NONE>"}])


def test_run_corrector_joins_canonical_phones_into_a_space_separated_string():
    fake = FakeCorrector()
    canonical = [
        CanonicalWord(word="he", phones=["HH", "IY"]),
        CanonicalWord(word="likes", phones=["L", "AY", "K", "S"]),
    ]

    log = run_corrector(fake, Path("/tmp/turn.wav"), canonical)

    assert fake.calls == [("/tmp/turn.wav", "HH IY L AY K S")]
    assert log == [{"src": "HH", "op": "KEEP", "ins": "<NONE>"}]


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
