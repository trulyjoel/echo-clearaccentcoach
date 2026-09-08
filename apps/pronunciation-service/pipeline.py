import subprocess
import tempfile
from pathlib import Path
from typing import Protocol

import torch
from torchaudio.functional import forced_align

from schemas import CanonicalWord, PronunciationEditOp

_NO_INSERTION = {"<NONE>", "NONE", "<PAD>"}


def _group_into_spans(aligned_frame_tokens: list[int]) -> list[tuple[int, list[int]]]:
    """Groups consecutive identical non-blank frame token ids into (token_id, frame_indices)
    spans, in target order — forced_align guarantees monotonic left-to-right target consumption.
    Only merges a frame into the previous span when it is truly contiguous with that span's last
    frame (no intervening blank) — a blank-separated repeat of the same phone (e.g. two distinct
    occurrences at a word boundary) must produce two separate spans, not one."""
    spans: list[tuple[int, list[int]]] = []
    for t, token_id in enumerate(aligned_frame_tokens):
        if token_id == 0:  # blank
            continue
        if spans and spans[-1][0] == token_id and spans[-1][1][-1] == t - 1:
            spans[-1][1].append(t)
        else:
            spans.append((token_id, [t]))
    return spans


GOP_MISPRONUNCIATION_THRESHOLD = -3.0

# Phones tolerated as an acceptable realization of the canonical phone, checked before
# threshold-based scoring — mirrors g2p.ts's PHONE_NORMALIZATION idea (normalize known variation)
# applied to a different problem. DX (the alveolar flap) is the normal realization of an
# intervocalic /t/ or /d/ in fluent American English ("butter", "good day") — flagging it as a
# mispronunciation of D or T produced exactly this false positive on a fluent native recording
# during this feature's investigation. Starts narrow; grows only from real observed false
# positives, not speculatively.
ACCEPTABLE_REALIZATIONS: dict[str, set[str]] = {
    "D": {"DX"},
    "T": {"DX"},
}


class Recognizer(Protocol):
    """What score_pronunciation needs from a phone-recognition model — satisfied structurally by
    models.py's HuperRecognizer, with no inheritance relationship required."""

    label2id: dict[str, int]
    id2label: dict[int, str]

    def log_probs(self, waveform) -> torch.Tensor:
        """Returns log-softmax'd per-frame class log-probabilities, shape (1, T, C)."""
        ...


def score_pronunciation(
    recognizer: Recognizer,
    waveform,
    canonical_phones: list[CanonicalWord],
) -> list[PronunciationEditOp]:
    """Forced-aligns `canonical_phones` to `recognizer`'s emissions for `waveform` (a 16kHz mono
    array — see Task 4's `load_waveform` for how a real one is produced), then reports a
    substitution for any phone whose Goodness-of-Pronunciation score falls below threshold and
    isn't an accepted allophonic variant (see ACCEPTABLE_REALIZATIONS).

    Does not detect insertions (forced alignment can't represent an extra, non-canonical phone —
    see the design spec's Non-goals) or, in the rare case of two identical adjacent canonical
    phones with no acoustic separation between them, the second occurrence (see
    _group_into_spans's docstring).
    """
    log_probs = recognizer.log_probs(waveform)

    flat_phones = [phone for word in canonical_phones for phone in word.phones]
    word_positions = [
        (word.word, word_index)
        for word_index, word in enumerate(canonical_phones)
        for _ in word.phones
    ]
    target_ids = torch.tensor(
        [[recognizer.label2id[p] for p in flat_phones]], dtype=torch.int64
    )
    input_lengths = torch.tensor([log_probs.shape[1]], dtype=torch.int64)
    target_lengths = torch.tensor([len(flat_phones)], dtype=torch.int64)

    aligned, _scores = forced_align(log_probs, target_ids, input_lengths, target_lengths, blank=0)
    spans = _group_into_spans(aligned[0].tolist())

    ops: list[PronunciationEditOp] = []
    frames = log_probs[0]  # (T, C)
    for i, (canonical_phone, (word, word_index)) in enumerate(
        zip(flat_phones, word_positions, strict=True)
    ):
        if i >= len(spans):
            continue  # repeated-adjacent-phone collapse — see _group_into_spans's docstring
        token_id, frame_indices = spans[i]
        span_log_probs = frames[frame_indices]  # (num_frames, C)
        canonical_lp = span_log_probs[:, token_id]
        best_lp, best_id = span_log_probs.max(dim=-1)
        gop = (canonical_lp - best_lp).mean().item()
        most_likely_phone = recognizer.id2label[int(best_id.mode().values.item())]

        if most_likely_phone in ACCEPTABLE_REALIZATIONS.get(canonical_phone, set()):
            continue
        if gop < GOP_MISPRONUNCIATION_THRESHOLD:
            ops.append(
                PronunciationEditOp(
                    word=word,
                    wordIndex=word_index,
                    op="sub",
                    expectedPhoneme=canonical_phone,
                    spokenPhoneme=most_likely_phone,
                )
            )
    return ops


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
