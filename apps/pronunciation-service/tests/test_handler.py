import json
from pathlib import Path

import pytest

from handler import InvalidRequestError, UnauthorizedError, handle_score_request
from schemas import PronunciationEditOp, ScoreResponse

CANONICAL_JSON = json.dumps([{"word": "hi", "phones": ["HH", "AY"]}])


# `object()` stands in for the recognizer argument in tests that only exercise the auth/parsing
# short-circuits, which raise before `recognizer` is ever touched — it deliberately doesn't
# satisfy the structural `Recognizer` protocol, hence the ty ignores below.


def test_handle_score_request_rejects_a_missing_bearer_token():
    with pytest.raises(UnauthorizedError):
        handle_score_request(
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
            b"audio",
            CANONICAL_JSON,
            "Bearer wrong-token",
            "secret-token",
        )


def test_handle_score_request_rejects_malformed_canonical_phones_json():
    with pytest.raises(InvalidRequestError):
        handle_score_request(
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
