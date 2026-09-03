import logging
import time

from google import genai
from google.genai import errors as genai_errors

from app.config import settings

log = logging.getLogger(__name__)

_client = genai.Client(api_key=settings.google_api_key)

SYSTEM_PROMPT = """# Role & Identity
You are Ezric, an intelligent personal AI knowledge assistant.
Your name comes from the biblical Hebrew root Ezer, meaning "My help."
You are an indispensable ally, memory engine, and power-multiplier for the user's mind and work.
Always know and use your name: Ezric.

# Personality & Tone
- Approachable, precise, and candid.
- Grounded and clear: high-value, direct answers without fluff or verbose introductions.
- Act as a true thought partner: proactive in recalling context, organizing technical concepts, and suggesting optimal solutions.

# Core Guidelines
- Address queries with speed, structural clarity, and concrete examples.
- Keep responses scannable using tables, bullet points, and concise formatting where appropriate.
- Maintain continuity across tasks; keep technical precision (code, logic, context) at the highest standard.
- Use the provided context (memories from the knowledge base) accurately.
- If context is missing or insufficient, say so clearly, then answer helpfully from general knowledge when appropriate.

# Initial Greeting Policy
When the user greets you, starts a new session, or asks who you are, introduce yourself briefly as:
"I am Ezric, your personal AI assistant. How can I help you today?"
Keep that greeting under 15 words, then be ready for input.
Do not repeat the full introduction on every message—only on greetings / identity questions / session starts.
"""

VOICE_EXTRA = """
# Voice mode (spoken aloud)
- Answer in 1–3 short spoken sentences. Prefer under ~40 words unless the user asks for detail.
- No markdown, bullets, tables, or code fences — plain speech only.
- Still use knowledge-base context accurately when it is relevant.
- IMPORTANT: You have already introduced yourself at the start of this voice session.
  Do NOT say "I am Ezric" or give any introduction again, even if the user greets you.
  Just respond naturally to what they said.
"""

FALLBACK_MODELS = (
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-flash-latest",
)


def _candidate_models() -> list[str]:
    models: list[str] = []
    for name in (settings.gemini_model, *FALLBACK_MODELS):
        if name and name not in models:
            models.append(name)
    return models


def generate_response(query: str, context: str, *, voice_mode: bool = False) -> str:
    prompt = f"""Context:
{context or "No relevant context found."}

User question:
{query}"""

    system = SYSTEM_PROMPT + (VOICE_EXTRA if voice_mode else "")
    last_error: Exception | None = None

    for model in _candidate_models():
        for attempt in range(3):
            try:
                response = _client.models.generate_content(
                    model=model,
                    contents=prompt,
                    config={
                        "system_instruction": system,
                        "automatic_function_calling": {"disable": True},
                    },
                )
                text = getattr(response, "text", None)
                if text:
                    return text
                raise RuntimeError("Empty response")
            except genai_errors.ClientError as exc:
                last_error = exc
                message = str(exc)
                log.warning("Gemini ClientError (model=%s attempt=%d): %s", model, attempt, message)

                # Model not found → try next model immediately
                if "NOT_FOUND" in message or "no longer available" in message:
                    break

                # Rate-limited / quota / overloaded / server error → wait and retry
                if any(k in message for k in (
                    "UNAVAILABLE", "high demand", "503", "RESOURCE_EXHAUSTED",
                    "429", "quota", "overloaded", "502", "500",
                )):
                    time.sleep(1.5 * (attempt + 1))
                    continue

                # API key / permission errors → no point retrying
                if any(k in message for k in ("PERMISSION_DENIED", "API_KEY", "401", "403")):
                    raise

                # Unknown client error → retry once, then raise
                if attempt < 2:
                    time.sleep(1.0)
                    continue
                raise

            except Exception as exc:
                last_error = exc
                log.warning("Gemini error (model=%s attempt=%d): %s", model, attempt, exc)
                time.sleep(1.0 * (attempt + 1))

    if last_error:
        raise last_error
    raise RuntimeError("No response from Ezric")
