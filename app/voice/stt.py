import tempfile
from pathlib import Path

from faster_whisper import WhisperModel

from app.config import settings

_model: WhisperModel | None = None


def _get_model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel(settings.whisper_model, device="cpu", compute_type="int8")
    return _model


def transcribe_audio(audio_bytes: bytes, filename: str = "audio.wav") -> str:
    suffix = Path(filename).suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(audio_bytes)
        tmp.flush()
        segments, _ = _get_model().transcribe(tmp.name)
        return " ".join(segment.text.strip() for segment in segments).strip()
