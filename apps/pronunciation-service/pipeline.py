import subprocess
import tempfile
from pathlib import Path
from typing import Protocol

from schemas import CanonicalWord, PronunciationEditOp

_NO_INSERTION = {"<NONE>", "NONE", "<PAD>"}


def decode_audio(webm_bytes: bytes) -> Path:
    """Decodes a WebM/Opus turn recording to a 16kHz mono WAV file at a temp path.

    The caller is responsible for deleting the returned path once done with it.
    """
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()

    result = subprocess.run(
        ["ffmpeg", "-y", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "wav", str(tmp_path)],
        input=webm_bytes,
        capture_output=True,
    )
    if result.returncode != 0:
        tmp_path.unlink(missing_ok=True)
        stderr = result.stderr.decode(errors="replace")
        raise RuntimeError(f"ffmpeg decode failed: {stderr}")
    return tmp_path


def to_edit_ops(
    log: list[dict], canonical_phones: list[CanonicalWord]
) -> list[PronunciationEditOp]:
    """Maps the Corrector's per-position edit log onto the wire-format edit-op list.

    `log` must have exactly one entry per canonical phone, in the same order the phones were
    flattened into the `text` passed to `predict()`.
    """
    positions = [
        (word.word, word_index)
        for word_index, word in enumerate(canonical_phones)
        for _ in word.phones
    ]
    if len(positions) != len(log):
        raise ValueError(
            f"log length {len(log)} does not match canonical phone count {len(positions)}"
        )

    ops: list[PronunciationEditOp] = []
    for (word_text, word_index), entry in zip(positions, log, strict=True):
        op = entry["op"]
        src = entry["src"]
        ins = entry["ins"]

        if op == "DEL":
            ops.append(
                PronunciationEditOp(
                    word=word_text, wordIndex=word_index, op="del",
                    expectedPhoneme=src, spokenPhoneme=None,
                )
            )
        elif op.startswith("SUB:") and op != "SUB:<PAD>":
            ops.append(
                PronunciationEditOp(
                    word=word_text, wordIndex=word_index, op="sub",
                    expectedPhoneme=src, spokenPhoneme=op.removeprefix("SUB:"),
                )
            )

        if ins not in _NO_INSERTION:
            ops.append(
                PronunciationEditOp(
                    word=word_text, wordIndex=word_index, op="ins",
                    expectedPhoneme=None, spokenPhoneme=ins,
                )
            )
    return ops


class Corrector(Protocol):
    def predict(self, wav_path: str, text: str) -> tuple[list[str], list[dict]]: ...


def run_corrector(
    corrector: Corrector, wav_path: Path, canonical_phones: list[CanonicalWord]
) -> list[dict]:
    """Runs the Corrector against a turn's decoded audio and canonical phones, returning the
    per-position edit log (discards `final_phonemes`, which nothing downstream needs)."""
    text = " ".join(phone for word in canonical_phones for phone in word.phones)
    _final_phonemes, log = corrector.predict(str(wav_path), text)
    return log
