import wave
from pathlib import Path

import pytest

from pipeline import decode_audio, to_edit_ops
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
