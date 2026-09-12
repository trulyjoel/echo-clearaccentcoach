import os

import modal
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

from handler import InvalidRequestError, UnauthorizedError, handle_score_request
from models import Wav2Vec2XlsrRecognizer
from schemas import ScoreResponse


def _download_recognizer() -> None:
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
    .add_local_python_source("handler", "models", "pipeline", "schemas", copy=True)
    .run_function(_download_recognizer)
)

app = modal.App("kalli-pronunciation-service", image=image)
auth_secret = modal.Secret.from_name("pronunciation-service-auth")


@app.cls(gpu="T4", secrets=[auth_secret], min_containers=0)
class PronunciationService:
    @modal.enter()
    def load(self) -> None:
        self.recognizer = Wav2Vec2XlsrRecognizer()

    @modal.asgi_app()
    def web(self) -> FastAPI:
        # @modal.fastapi_endpoint has no path parameter - it always serves at the URL root, which
        # doesn't match the already-shipped TS adapter's fixed `POST {url}/score` contract. A
        # manually-built FastAPI app under @modal.asgi_app lets /score be an explicit route instead
        # of changing that contract to fit the decorator's default.
        web_app = FastAPI()

        @web_app.get("/health")
        async def health(authorization: str | None = Header(None)) -> dict[str, str]:
            # Hitting any endpoint is enough to trigger Modal's cold start (@modal.enter loads the
            # model before this handler runs), so the server calls this at session start purely to
            # eat that latency before the first turn needs real scoring.
            if authorization != f"Bearer {os.environ['PRONUNCIATION_SERVICE_TOKEN']}":
                raise HTTPException(status_code=401, detail="invalid or missing bearer token")
            return {"status": "ok"}

        @web_app.post("/score")
        async def score(
            audio: UploadFile = File(...),
            canonical_phones: str = Form(...),
            authorization: str | None = Header(None),
        ) -> ScoreResponse:
            try:
                return handle_score_request(
                    self.recognizer,
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
