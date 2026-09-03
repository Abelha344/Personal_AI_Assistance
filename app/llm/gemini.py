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
- Prefer short paragraphs and simple numbered lists. Avoid markdown tables, --- rules, and ### headings.
- Maintain continuity across tasks; keep technical precision (code, logic, context) at the highest standard.
- Use the provided context (memories from the knowledge base) accurately.
- If context is missing or insufficient, say so clearly, then answer helpfully from general knowledge when appropriate.

# Initial Greeting Policy
On the VERY FIRST message of a session, introduce yourself briefly as:
"I am Ezric, your personal AI assistant. How can I help you today?"
Keep that greeting under 15 words.
After that first introduction, NEVER repeat it — even if the user says hello again, just respond naturally.
"""

VOICE_EXTRA = """
# Voice mode (spoken aloud)
- Answer in plain spoken English only. Prefer 2–5 short sentences (under ~80 words) unless the user asks for more detail.
- NEVER use markdown: no # headings, no --- lines, no | tables, no **bold**, no bullets with -, no code fences.
- Use numbered sentences like "First… Second…" if you need structure.
- Still use knowledge-base context accurately when it is relevant.
- IMPORTANT: You have already introduced yourself at the start of this voice session.
  Do NOT say "I am Ezric" or give any introduction again, even if the user greets you.
  Just respond naturally to what they said.
"""

CHAT_FORMAT = """
# Response formatting (typed chat)
- Prefer short paragraphs and simple numbered lists (1. 2. 3.).
- Do NOT use markdown tables, --- horizontal rules, or ### headings.
- Avoid dense symbols. Light bold is OK sparingly; never dump raw formatting for the user to read.
"""

NO_REINTRO = (
    "\n# Session continuity\n"
    "You have already introduced yourself earlier in this session. "
    "Do NOT say 'I am Ezric' or reintroduce yourself again under any circumstances. "
    "Just answer naturally.\n"
)

# Stable aliases that work for current Google AI Studio keys
FALLBACK_MODELS = (
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-3-flash-preview",
    "gemini-3.6-flash",
)


def _candidate_models() -> list[str]:
    models: list[str] = []
    for name in (settings.gemini_model, *FALLBACK_MODELS):
        if name and name not in models:
            models.append(name)
    return models


def generate_response(
    query: str,
    context: str,
    *,
    voice_mode: bool = False,
    already_greeted: bool = False,
) -> str:
    prompt = f"""Context:
{context or "No relevant context found."}

User question:
{query}"""

    system = SYSTEM_PROMPT
    if voice_mode:
        system += VOICE_EXTRA
    else:
        system += CHAT_FORMAT
    if already_greeted:
        system += NO_REINTRO

    last_error: Exception | None = None

    for model in _candidate_models():
        for attempt in range(2):
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
                    log.info("Gemini ok model=%s", model)
                    return text
                raise RuntimeError("Empty response")
            except genai_errors.ClientError as exc:
                last_error = exc
                message = str(exc)
                log.warning(
                    "Gemini ClientError (model=%s attempt=%d): %s",
                    model,
                    attempt,
                    message[:300],
                )

                # Dead model → try next candidate immediately
                if "NOT_FOUND" in message or "no longer available" in message:
                    break

                # Quota / rate limit → short wait, then try next model
                if any(
                    k in message
                    for k in (
                        "RESOURCE_EXHAUSTED",
                        "429",
                        "quota",
                        "UNAVAILABLE",
                        "high demand",
                        "503",
                        "overloaded",
                        "502",
                        "500",
                    )
                ):
                    time.sleep(0.8 * (attempt + 1))
                    if attempt == 0:
                        continue
                    break  # move to next model

                if any(k in message for k in ("PERMISSION_DENIED", "API_KEY", "401", "403")):
                    raise

                if attempt == 0:
                    time.sleep(0.6)
                    continue
                break
            except Exception as exc:
                last_error = exc
                log.warning(
                    "Gemini error (model=%s attempt=%d): %s",
                    model,
                    attempt,
                    exc,
                )
                time.sleep(0.6 * (attempt + 1))

    if last_error:
        raise last_error
    raise RuntimeError("No response from Ezric")
