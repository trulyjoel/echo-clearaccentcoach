import json
from pathlib import Path

import pytest

from handler import InvalidRequestError, UnauthorizedError, handle_score_request
from schemas import ScoreResponse


class FakeCorrector:
    def predict(self, wav_path: str, text: str) -> tuple[list[str], list[dict]]:
        # One canonical phone in, matching a single-word "hi" -> ["HH", "AY"] request below.
        return (["HH", "AY"], [
            {"src": "HH", "op": "KEEP", "ins": "<NONE>"},
            {"src": "AY", "op": "SUB:EY", "ins": "<NONE>"},
        ])


CANONICAL_JSON = json.dumps([{"word": "hi", "phones": ["HH", "AY"]}])


def test_handle_score_request_rejects_a_missing_bearer_token():
    with pytest.raises(UnauthorizedError):
        handle_score_request(FakeCorrector(), b"audio", CANONICAL_JSON, None, "secret-token")


def test_handle_score_request_rejects_a_wrong_bearer_token():
    with pytest.raises(UnauthorizedError):
        handle_score_request(
            FakeCorrector(), b"audio", CANONICAL_JSON, "Bearer wrong-token", "secret-token"
        )


def test_handle_score_request_rejects_malformed_canonical_phones_json():
    with pytest.raises(InvalidRequestError):
        handle_score_request(
            FakeCorrector(), b"audio", "not json", "Bearer secret-token", "secret-token"
        )


def test_handle_score_request_rejects_canonical_phones_missing_required_fields():
    with pytest.raises(InvalidRequestError):
        handle_score_request(
            FakeCorrector(),
            b"audio",
            json.dumps([{"word": "hi"}]),
            "Bearer secret-token",
            "secret-token",
        )


def test_handle_score_request_returns_edit_ops_on_success(monkeypatch):
    monkeypatch.setattr("handler.decode_audio", lambda _audio_bytes: Path("/tmp/turn.wav"))

    result = handle_score_request(
        FakeCorrector(), b"audio", CANONICAL_JSON, "Bearer secret-token", "secret-token"
    )

    assert isinstance(result, ScoreResponse)
    assert len(result.editOps) == 1
    assert result.editOps[0].op == "sub"
    assert result.editOps[0].expectedPhoneme == "AY"
    assert result.editOps[0].spokenPhoneme == "EY"
