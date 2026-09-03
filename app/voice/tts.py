import asyncio
import re
import tempfile
from pathlib import Path

import edge_tts


def strip_markdown_for_speech(text: str) -> str:
    """Remove markdown / symbols so TTS does not speak 'hash' or 'dash'."""
    if not text:
        return ""
    s = text
    s = re.sub(r"```[\s\S]*?```", " ", s)
    s = re.sub(r"`([^`]+)`", r"\1", s)
    s = re.sub(r"^#{1,6}\s*", "", s, flags=re.MULTILINE)
    s = re.sub(r"^\s*[-*_]{3,}\s*$", " ", s, flags=re.MULTILINE)
    s = re.sub(r"\|", " ", s)
    s = re.sub(r":?-{3,}:?", " ", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"\1", s)
    s = re.sub(r"\*([^*]+)\*", r"\1", s)
    s = re.sub(r"__([^_]+)__", r"\1", s)
    s = re.sub(r"_([^_]+)_", r"\1", s)
    s = re.sub(r"^\s*[-*+]\s+", "", s, flags=re.MULTILINE)
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
    s = re.sub(r"[#>~`|]+", " ", s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


async def synthesize_speech(text: str, voice: str = "en-US-AriaNeural") -> bytes:
    clean = strip_markdown_for_speech(text)
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        output_path = Path(tmp.name)

    communicate = edge_tts.Communicate(clean, voice)
    await communicate.save(str(output_path))

    try:
        return output_path.read_bytes()
    finally:
        output_path.unlink(missing_ok=True)


def text_to_speech(text: str, voice: str = "en-US-AriaNeural") -> bytes:
    return asyncio.run(synthesize_speech(text, voice=voice))
