import os

import modal
from fastapi import File, Form, Header, HTTPException, UploadFile

from handler import InvalidRequestError, UnauthorizedError, handle_score_request
from models import HuperCorrector
from schemas import ScoreResponse

MODEL_DIR = "/model"


def _download_corrector() -> None:
    # ty: ignore[unresolved-import] -- only installed inside the Modal image, not the local venv
    from huggingface_hub import snapshot_download

    snapshot_download("huper29/huper_corrector", local_dir=MODEL_DIR)


image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("ffmpeg")
    .pip_install(
        "torch==2.14.0",
        "torchaudio==2.11.0",
        "transformers==5.16.1",
        "huggingface-hub==1.30.0",
        "fastapi==0.141.1",
        "python-multipart==0.0.32",
        "pydantic==2.13.5",
    )
    .add_local_python_source("handler", "models", "pipeline", "schemas", copy=True)
    .run_function(_download_corrector)
)

app = modal.App("kalli-pronunciation-service", image=image)
auth_secret = modal.Secret.from_name("pronunciation-service-auth")


@app.cls(gpu="T4", secrets=[auth_secret], min_containers=0)
class PronunciationService:
    @modal.enter()
    def load(self) -> None:
        self.corrector = HuperCorrector(
            checkpoint_path=f"{MODEL_DIR}/model.safetensors",
            vocab_path=f"{MODEL_DIR}/edit_seq_speech/config/vocab.json",
        )

    @modal.fastapi_endpoint(method="POST")
    async def score(
        self,
        audio: UploadFile = File(...),
        canonical_phones: str = Form(...),
        authorization: str | None = Header(None),
    ) -> ScoreResponse:
        try:
            return handle_score_request(
                self.corrector,
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
