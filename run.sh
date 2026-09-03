#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -d .venv ]]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi

if [[ ! -f .env ]]; then
  if [[ -f .env.example ]]; then
    cp .env.example .env
    echo "Created .env from .env.example — edit it with your real credentials before using /chat or /documents."
  else
    echo "Missing .env — create one with GOOGLE_API_KEY and DATABASE_URL."
    exit 1
  fi
fi

PORT="${PORT:-8010}"

if ss -tln 2>/dev/null | grep -q ":${PORT} "; then
  for candidate in 8011 8012 8013 8020 8888; do
    if ! ss -tln 2>/dev/null | grep -q ":${candidate} "; then
      echo "Port ${PORT} is in use (likely another app). Using ${candidate} instead."
      PORT="$candidate"
      break
    fi
  done
fi

echo "Starting server on http://localhost:${PORT}"
exec .venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port "$PORT"
