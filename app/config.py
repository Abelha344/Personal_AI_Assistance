import sys
from pathlib import Path

from pydantic import ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(".env")
ENV_EXAMPLE = Path(".env.example")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    google_api_key: str
    database_url: str

    gemini_model: str = "gemini-2.5-flash"
    gemini_embedding_model: str = "gemini-embedding-001"
    whisper_model: str = "tiny"
    whisper_language: str = "en"
    top_k: int = 5

    @property
    def is_configured(self) -> bool:
        return (
            self.google_api_key not in {"", "your_google_api_key"}
            and "ep-xxx" not in self.database_url
            and "password@" not in self.database_url
        )


def _settings_help() -> str:
    return (
        "\nConfiguration required. Create and edit .env:\n\n"
        "  cp .env.example .env\n\n"
        "Set these values in .env:\n"
        "  GOOGLE_API_KEY   → https://aistudio.google.com/apikey\n"
        "  DATABASE_URL     → Neon connection string (enable pgvector, run scripts/init_db.sql)\n"
    )


def load_settings() -> Settings:
    if not ENV_FILE.exists():
        print(_settings_help(), file=sys.stderr)
        raise SystemExit(1)

    try:
        return Settings()
    except ValidationError:
        print(_settings_help(), file=sys.stderr)
        raise SystemExit(1) from None


settings = load_settings()
