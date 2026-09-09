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
            logger.info(
                "comparison scoring: words=%s served=%s comparison=%s",
                [word.word for word in words],
                edit_ops,
                comparison_ops,
            )
        except Exception:
            logger.exception("comparison scoring failed")
    finally:
        wav_path.unlink(missing_ok=True)

    return ScoreResponse(editOps=edit_ops)
