class HuperCorrector:
    """Thin wrapper around `edit_seq_speech.inference.PhonemeCorrectionInference`.

    The import is deferred to `__init__` (rather than module level) because `edit_seq_speech` is
    bundled inside the `huper29/huper_corrector` Hugging Face repo and only present in the built
    Modal container image — never in the local dev/test venv (see Task 2's note).
    """

    def __init__(self, checkpoint_path: str, vocab_path: str) -> None:
        import sys
        from pathlib import Path

        # `edit_seq_speech` is a plain directory inside the downloaded HF repo, not an installed
        # package - it's only importable once its containing directory is on sys.path, matching
        # the model's own quickstart (`sys.path.append(repo_dir)`).
        repo_dir = str(Path(checkpoint_path).parent)
        if repo_dir not in sys.path:
            sys.path.append(repo_dir)

        # ty: ignore[unresolved-import] -- bundled in the HF repo, present only in the Modal image
        from edit_seq_speech.inference import PhonemeCorrectionInference

        self._infer = PhonemeCorrectionInference(
            checkpoint_path=checkpoint_path, vocab_path=vocab_path
        )

    def predict(self, wav_path: str, text: str) -> tuple[list[str], list[dict]]:
        return self._infer.predict(wav_path, text)
