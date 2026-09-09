import logging
import os

import modal
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

from arpabet_to_ipa import ARPABET_TO_IPA
from handler import InvalidRequestError, UnauthorizedError, handle_score_request
from models import HuperRecognizer, Wav2Vec2XlsrRecognizer
from schemas import ScoreResponse

# Configured once here, in the container entrypoint Modal actually imports and runs - not in
# handler.py, which is a library module other things import. Without this, the root logger's
# default WARNING level silently drops handler.py's INFO-level comparison-scoring log line.
logging.basicConfig(level=logging.INFO)
# Belt-and-braces: if a future Modal SDK version installs its own root handler before this module
# runs, basicConfig above becomes a no-op (it only configures when no handler exists yet), which
# would silently reintroduce the exact bug this logging setup exists to fix. Setting handler.py's
# logger level directly is independent of the root logger's configuration state.
logging.getLogger("handler").setLevel(logging.INFO)


def _download_recognizer() -> None:
    # ty: ignore[unresolved-import] -- only installed inside the Modal image, not the local venv
    from transformers import Wav2Vec2Processor, WavLMForCTC

    Wav2Vec2Processor.from_pretrained("huper29/huper_recognizer")
    WavLMForCTC.from_pretrained("huper29/huper_recognizer")


def _download_comparison_recognizer() -> None:
    # Both imports below are only installed inside the Modal image, not the local venv.
    from huggingface_hub import hf_hub_download  # ty: ignore[unresolved-import]
    from transformers import (  # ty: ignore[unresolved-import]
        Wav2Vec2FeatureExtractor,
        Wav2Vec2ForCTC,
    )

    repo_id = "facebook/wav2vec2-xlsr-53-espeak-cv-ft"
    Wav2Vec2FeatureExtractor.from_pretrained(repo_id)
    Wav2Vec2ForCTC.from_pretrained(repo_id)
    hf_hub_download(repo_id, "vocab.json")


image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("ffmpeg")
    .pip_install(
        "torch==2.14.0",
        "torchaudio==2.11.0",
        "soundfile==0.14.0",
        "transformers==5.16.1",
        "huggingface-hub==1.30.0",
        "fastapi==0.141.1",
        "python-multipart==0.0.32",
        "pydantic==2.13.5",
    )
    .add_local_python_source(
        "arpabet_to_ipa", "handler", "models", "pipeline", "schemas", copy=True
    )
    .run_function(_download_recognizer)
    .run_function(_download_comparison_recognizer)
)

app = modal.App("kalli-pronunciation-service", image=image)
auth_secret = modal.Secret.from_name("pronunciation-service-auth")


@app.cls(gpu="T4", secrets=[auth_secret], min_containers=0)
class PronunciationService:
    @modal.enter()
    def load(self) -> None:
        self.recognizer = HuperRecognizer()
        self.comparison_recognizer = Wav2Vec2XlsrRecognizer()
        # Without this, a wrong ARPABET_TO_IPA entry silently drops every turn's comparison result
        # forever (score_pronunciation raises ValueError, handler.py's try/except only logs it) —
        # indistinguishable in logs from "no mispronunciation found." Fail loud at deploy time
        # instead.
        missing = set(ARPABET_TO_IPA.values()) - set(self.comparison_recognizer.label2id)
        assert not missing, (
            f"ARPABET_TO_IPA maps IPA symbols missing from comparison recognizer's vocabulary: "
            f"{missing}"
        )

    @modal.asgi_app()
    def web(self) -> FastAPI:
        # @modal.fastapi_endpoint has no path parameter - it always serves at the URL root, which
        # doesn't match the already-shipped TS adapter's fixed `POST {url}/score` contract. A
        # manually-built FastAPI app under @modal.asgi_app lets /score be an explicit route instead
        # of changing that contract to fit the decorator's default.
        web_app = FastAPI()

        @web_app.post("/score")
        async def score(
            audio: UploadFile = File(...),
            canonical_phones: str = Form(...),
            authorization: str | None = Header(None),
        ) -> ScoreResponse:
            try:
                return handle_score_request(
                    self.recognizer,
                    self.comparison_recognizer,
                    await audio.read(),
                    canonical_phones,
                    authorization,
                    os.environ["PRONUNCIATION_SERVICE_TOKEN"],
                )
            except UnauthorizedError as exc:
                raise HTTPException(status_code=401, detail=str(exc)) from exc
            except InvalidRequestError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            except Exception as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc

        return web_app
