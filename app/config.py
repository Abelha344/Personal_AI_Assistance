import os
import sys
from pathlib import Path

from pydantic import ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(".env")


class Settings(BaseSettings):
    # Works with local .env OR platform env vars (Render, etc.)
    model_config = SettingsConfigDict(
        env_file=".env" if ENV_FILE.exists() else None,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    google_api_key: str
    database_url: str

    gemini_model: str = "gemini-3.6-flash"
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
        "\nConfiguration required.\n\n"
        "Local: create .env from .env.example and set GOOGLE_API_KEY + DATABASE_URL.\n"
        "Render: set the same keys under Environment (no .env file needed).\n"
        "  GOOGLE_API_KEY   → https://aistudio.google.com/apikey\n"
        "  DATABASE_URL     → Neon connection string (pgvector + init_db.sql)\n"
    )


def load_settings() -> Settings:
    has_local_env = ENV_FILE.exists()
    has_platform_env = bool(os.getenv("GOOGLE_API_KEY") and os.getenv("DATABASE_URL"))
    if not has_local_env and not has_platform_env:
        print(_settings_help(), file=sys.stderr)
        raise SystemExit(1)

    try:
        return Settings()
    except ValidationError:
        print(_settings_help(), file=sys.stderr)
        raise SystemExit(1) from None


settings = load_settings()
