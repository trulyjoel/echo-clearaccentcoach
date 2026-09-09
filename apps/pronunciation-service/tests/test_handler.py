import json
from pathlib import Path

import pytest

from handler import InvalidRequestError, UnauthorizedError, handle_score_request
from schemas import PronunciationEditOp, ScoreResponse

CANONICAL_JSON = json.dumps([{"word": "hi", "phones": ["HH", "AY"]}])


# `object()` stands in for the recognizer arguments in tests that only exercise the auth/parsing
# short-circuits, which raise before `recognizer` is ever touched — it deliberately doesn't
# satisfy the structural `Recognizer` protocol, hence the ty ignores below.


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


def test_handle_score_request_returns_edit_ops_on_success(monkeypatch):
    monkeypatch.setattr("handler.decode_audio", lambda _audio_bytes: Path("/tmp/turn.wav"))
    monkeypatch.setattr("handler.load_waveform", lambda _wav_path: object())
    monkeypatch.setattr("handler.to_ipa_phones", lambda words: words)
    monkeypatch.setattr(
        "handler.score_pronunciation",
        lambda _recognizer, _waveform, _words: [
            PronunciationEditOp(
                word="hi", wordIndex=0, op="sub", expectedPhoneme="AY", spokenPhoneme="EY"
            )
        ],
    )

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
