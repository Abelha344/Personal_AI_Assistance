import time

from google import genai
from google.genai import errors as genai_errors

from app.config import settings

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


def generate_response(query: str, context: str) -> str:
    prompt = f"""Context:
{context or "No relevant context found."}

User question:
{query}"""

    last_error: Exception | None = None

    for model in _candidate_models():
        for attempt in range(2):
            try:
                response = _client.models.generate_content(
                    model=model,
                    contents=prompt,
                    config={
                        "system_instruction": SYSTEM_PROMPT,
                        "automatic_function_calling": {"disable": True},
                    },
                )
                text = getattr(response, "text", None)
                if text:
                    return text
                raise RuntimeError("Empty response from Gemini")
            except genai_errors.ClientError as exc:
                last_error = exc
                message = str(exc)
                if "NOT_FOUND" in message or "no longer available" in message:
                    break
                if "UNAVAILABLE" in message or "high demand" in message or "503" in message:
                    time.sleep(0.6 * (attempt + 1))
                    continue
                raise
            except Exception as exc:
                last_error = exc
                time.sleep(0.4)

    if last_error:
        raise last_error
    raise RuntimeError("Gemini returned no response")
