import subprocess
import tempfile
from pathlib import Path


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
