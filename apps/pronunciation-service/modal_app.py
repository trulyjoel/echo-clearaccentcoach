import os

import modal
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

from handler import InvalidRequestError, UnauthorizedError, handle_score_request
from models import HuperRecognizer
from schemas import ScoreResponse


def _download_recognizer() -> None:
    # ty: ignore[unresolved-import] -- only installed inside the Modal image, not the local venv
    from transformers import Wav2Vec2Processor, WavLMForCTC

    Wav2Vec2Processor.from_pretrained("huper29/huper_recognizer")
    WavLMForCTC.from_pretrained("huper29/huper_recognizer")


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
        self.recognizer = HuperRecognizer()

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
