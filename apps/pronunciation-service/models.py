class HuperRecognizer:
    """Wraps huper29/huper_recognizer, a standard `transformers` WavLM-Large CTC phone recognizer —
    unlike the HuPER Corrector this replaces, no bespoke `edit_seq_speech` package or sys.path
    hack is needed; it's loadable through `transformers` alone.
    """

    # Non-phone classes in HuPER's vocabulary (blank/padding and other special CTC tokens). A span
    # where these dominate the per-frame argmax is the recognizer's honest signal that nothing was
    # really articulated there, not a real (mispronounced) phone — see score_pronunciation's
    # deletion check. Every Recognizer implementation declares its own — this set is specific to
    # HuPER's vocabulary spelling and must not be assumed to match any other model's.
    non_phone_tokens: frozenset[str] = frozenset({"<PAD>", "<UNK>", "<BOS>", "<EOS>", "|"})

    def __init__(self, repo_id: str = "huper29/huper_recognizer") -> None:
        import torch
        from transformers import Wav2Vec2Processor, WavLMForCTC  # ty: ignore[unresolved-import]

        self.processor = Wav2Vec2Processor.from_pretrained(repo_id)
        self.model = WavLMForCTC.from_pretrained(repo_id)
        self.model.eval()
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model.to(self.device)
        self.label2id: dict[str, int] = dict(self.model.config.label2id)
        self.id2label: dict[int, str] = dict(self.model.config.id2label)

    def log_probs(self, waveform):
        """Returns log-softmax'd per-frame class log-probabilities for a 16kHz mono waveform,
        shape (1, T, C)."""
        import torch
        import torch.nn.functional as F

        inputs = self.processor(waveform, sampling_rate=16000, return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with torch.no_grad():
            logits = self.model(**inputs).logits
        return F.log_softmax(logits, dim=-1).cpu()
