class Wav2Vec2XlsrRecognizer:
    """Wraps facebook/wav2vec2-xlsr-53-espeak-cv-ft — loads only the feature extractor and CTC
    model, not the full Wav2Vec2Processor, to avoid that class's Wav2Vec2PhonemeCTCTokenizer
    pulling in the `phonemizer` package and an `espeak-ng` binary this use case never needs (only
    score_pronunciation's log-probs-based scoring is used here, never phonemizer's text-to-phoneme
    encoding).
    """

    # DX/flap tolerance for /d/ and /t/, in this model's lowercase IPA vocabulary — ɾ is the flap
    # symbol (see g2p.ts's IPA_TO_CANONICAL table).
    acceptable_realizations: dict[str, set[str]] = {
        "d": {"ɾ"},
        "t": {"ɾ"},
    }

    def __init__(self, repo_id: str = "facebook/wav2vec2-xlsr-53-espeak-cv-ft") -> None:
        import json

        import torch
        from huggingface_hub import hf_hub_download  # ty: ignore[unresolved-import]
        from transformers import (  # ty: ignore[unresolved-import]
            Wav2Vec2FeatureExtractor,
            Wav2Vec2ForCTC,
        )

        self.feature_extractor = Wav2Vec2FeatureExtractor.from_pretrained(repo_id)
        self.model = Wav2Vec2ForCTC.from_pretrained(repo_id)
        self.model.eval()
        assert self.model.config.pad_token_id == 0, (
            "score_pronunciation's forced_align call hardcodes blank=0 — this recognizer's "
            "pad/blank token must be id 0 for that to be correct"
        )
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model.to(self.device)

        vocab_path = hf_hub_download(repo_id, "vocab.json")
        with open(vocab_path) as f:
            self.label2id: dict[str, int] = json.load(f)
        self.id2label: dict[int, str] = {id_: label for label, id_ in self.label2id.items()}

        # Derived from the model's own config rather than hardcoding the special tokens' literal
        # string content. vocab.json's ids 0-3 turned out to be the distinct strings "<pad>",
        # "<s>", "</s>", "<unk>" (392 total entries, no collapse) — reading them back out through
        # id2label is correct regardless, so no assumption about their literal spelling is baked
        # in here. unk_token_id isn't a Wav2Vec2Config field, so it's read off the model config
        # with a default of None (mirrors HuPER's non_phone_tokens including "<UNK>").
        non_phone_ids = {
            self.model.config.pad_token_id,
            self.model.config.bos_token_id,
            self.model.config.eos_token_id,
            getattr(self.model.config, "unk_token_id", None),
        }
        self.non_phone_tokens: frozenset[str] = frozenset(
            self.id2label[id_] for id_ in non_phone_ids if id_ in self.id2label
        )

    def log_probs(self, waveform):
        """Returns log-softmax'd per-frame class log-probabilities for a 16kHz mono waveform,
        shape (1, T, C)."""
        import torch
        import torch.nn.functional as F

        inputs = self.feature_extractor(waveform, sampling_rate=16000, return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with torch.no_grad():
            logits = self.model(**inputs).logits
        return F.log_softmax(logits, dim=-1).cpu()
