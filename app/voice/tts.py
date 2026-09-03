import asyncio
import tempfile
from pathlib import Path

import edge_tts


async def synthesize_speech(text: str, voice: str = "en-US-AriaNeural") -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        output_path = Path(tmp.name)

    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(str(output_path))

    try:
        return output_path.read_bytes()
    finally:
        output_path.unlink(missing_ok=True)


def text_to_speech(text: str, voice: str = "en-US-AriaNeural") -> bytes:
    return asyncio.run(synthesize_speech(text, voice=voice))
