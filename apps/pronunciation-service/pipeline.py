import subprocess
import tempfile
from pathlib import Path
from typing import Protocol

import torch
from torchaudio.functional import forced_align

from schemas import CanonicalWord, PronunciationEditOp


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
    models.py's HuperRecognizer and Wav2Vec2XlsrRecognizer, with no inheritance relationship
    required."""

    label2id: dict[str, int]
    id2label: dict[int, str]
    non_phone_tokens: frozenset[str]

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
    flat_phones = [phone for word in canonical_phones for phone in word.phones]
    if not flat_phones:
        return []

    log_probs = recognizer.log_probs(waveform)

    word_positions = [
        (word.word, word_index)
        for word_index, word in enumerate(canonical_phones)
        for _ in word.phones
    ]
    target_id_list = []
    for phone in flat_phones:
        if phone not in recognizer.label2id:
            raise ValueError(f"canonical phone {phone!r} is not in the recognizer's vocabulary")
        target_id_list.append(recognizer.label2id[phone])
    target_ids = torch.tensor([target_id_list], dtype=torch.int64)

    if log_probs.shape[1] < len(flat_phones):
        raise ValueError(
            f"audio too short ({log_probs.shape[1]} frames) for {len(flat_phones)} canonical phones"
        )
    input_lengths = torch.tensor([log_probs.shape[1]], dtype=torch.int64)
    target_lengths = torch.tensor([len(flat_phones)], dtype=torch.int64)

    aligned, _scores = forced_align(log_probs, target_ids, input_lengths, target_lengths, blank=0)
    spans = _group_into_spans(aligned[0].tolist())

    non_phone_ids = [
        id_ for id_, label in recognizer.id2label.items() if label in recognizer.non_phone_tokens
    ]
    non_phone_mask = torch.zeros(log_probs.shape[-1])
    non_phone_mask[non_phone_ids] = float("-inf")

    ops: list[PronunciationEditOp] = []
    frames = log_probs[0]  # (T, C)
    for i, (canonical_phone, (word, word_index)) in enumerate(
        zip(flat_phones, word_positions, strict=True)
    ):
        assert i < len(spans), (
            f"expected one span per canonical phone (forced_align should never produce fewer "
            f"spans than target phones); got {len(spans)} spans for {len(flat_phones)} phones"
        )
        token_id, frame_indices = spans[i]
        span_log_probs = frames[frame_indices]  # (num_frames, C)
        canonical_lp = span_log_probs[:, token_id]

        raw_best_ids = span_log_probs.argmax(dim=-1).tolist()
        non_phone_frame_count = sum(1 for id_ in raw_best_ids if id_ in non_phone_ids)
        if non_phone_frame_count * 2 > len(frame_indices):
            ops.append(
                PronunciationEditOp(
                    word=word,
                    wordIndex=word_index,
                    op="del",
                    expectedPhoneme=canonical_phone,
                    spokenPhoneme=None,
                )
            )
            continue

        masked_span_log_probs = span_log_probs + non_phone_mask  # (num_frames, C)
        best_lp, best_id = masked_span_log_probs.max(dim=-1)
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


def load_waveform(wav_path: Path):
    """Reads a 16kHz mono WAV file (as produced by decode_audio) into a float32 array, for
    log_probs. Uses soundfile directly rather than torchaudio.load, which as of torchaudio's 2.x
    line requires an additional torchcodec backend dependency this service doesn't otherwise need.
    """
    import soundfile as sf

    waveform, _sample_rate = sf.read(str(wav_path), dtype="float32")
    return waveform
