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
    """Runs the full `/score` request: auth check, request parsing, the decode/score pipeline
    against `recognizer`, and response construction. Framework-agnostic — the caller
    (`modal_app.py`) translates the exceptions raised here to HTTP status codes.
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
