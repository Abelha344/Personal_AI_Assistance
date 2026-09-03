from google import genai
from google.genai import types

from app.config import settings

_client = genai.Client(api_key=settings.google_api_key)


def embed_text(text: str) -> list[float]:
    result = _client.models.embed_content(
        model=settings.gemini_embedding_model,
        contents=text,
        config=types.EmbedContentConfig(
            task_type="RETRIEVAL_QUERY",
            output_dimensionality=768,
        ),
    )
    return list(result.embeddings[0].values)
