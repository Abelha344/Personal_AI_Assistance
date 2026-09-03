import tempfile
from pathlib import Path

from faster_whisper import WhisperModel

from app.config import settings

_model: WhisperModel | None = None


def _get_model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel(
            settings.whisper_model,
            device="cpu",
            compute_type="int8",
            cpu_threads=4,
        )
    return _model


def warm_up() -> None:
    """Load Whisper into memory at startup so the first voice request is faster."""
    _get_model()


def transcribe_audio(audio_bytes: bytes, filename: str = "audio.wav") -> str:
    """Transcribe speech. English-only for now (WHISPER_LANGUAGE=en)."""
    suffix = Path(filename).suffix or ".wav"
    # Force English unless explicitly set to auto
    language = settings.whisper_language.strip().lower() if settings.whisper_language else "en"
    if language in {"auto", "detect"}:
        language = None
    else:
        language = language or "en"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(audio_bytes)
        tmp.flush()
        segments, _info = _get_model().transcribe(
            tmp.name,
            language=language,
            task="transcribe",
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
            beam_size=1,
            best_of=1,
            temperature=0.0,
            condition_on_previous_text=False,
            no_speech_threshold=0.55,
            compression_ratio_threshold=2.4,
            without_timestamps=True,
        )
        parts = [segment.text.strip() for segment in segments if segment.text.strip()]
        return " ".join(parts).strip()
