# Personal Assistant AI

Voice-driven personal assistant with RAG over Neon PostgreSQL.

## Architecture

```
Voice
  ↓
Speech → Text        (faster-whisper)
  ↓
FastAPI              (/voice, /chat)
  ↓
LangGraph            (retrieve → generate)
  ↓
Retrieve context     (pgvector similarity search)
  ↓
Neon + pgvector
  ↓
Gemini               (embeddings + generation)
  ↓
Response
  ↓
Text → Speech        (edge-tts)
```

## Setup

1. **Install (use `python3` on Ubuntu/Debian)**

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   .venv/bin/pip install -r requirements.txt
   ```

   If `python` is not found, always use `python3` or `.venv/bin/python3`.

2. **Configure environment**

   ```bash
   cp .env.example .env
   # Set GOOGLE_API_KEY and DATABASE_URL
   ```

3. **Initialize Neon database**

   - Create a Neon project and enable the `pgvector` extension.
   - Run `scripts/init_db.sql` in the SQL editor.

4. **Index documents**

   ```bash
   curl -X POST http://localhost:8010/documents \
     -H "Content-Type: application/json" \
     -d '{"content": "My meeting is every Monday at 9am.", "metadata": {"type": "calendar"}}'
   ```

5. **Run the server**

   Port 8000/8001 are often taken by other local apps. Default is **8010**:

   ```bash
   source .venv/bin/activate
   .venv/bin/uvicorn app.main:app --reload --port 8010
   ```

   Or use the helper script (auto-picks a free port if 8010 is busy):

   ```bash
   ./run.sh
   ```

## API

| Endpoint     | Method | Description                          |
|-------------|--------|--------------------------------------|
| `/health`   | GET    | Health check                         |
| `/chat`     | POST   | Text in → text response              |
| `/voice`    | POST   | Audio in → audio (or JSON) response  |
| `/documents`| POST   | Add content to the vector store      |

### Text chat

```bash
curl -X POST http://localhost:8010/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "When is my meeting?"}'
```

### Voice chat

Requires a local audio file (e.g. `question.wav`):

```bash
curl -X POST http://localhost:8010/voice \
  -F "audio=@question.wav" \
  -F "return_audio=true" \
  --output response.mp3
```

## Notes

- **Embeddings**: Gemini `gemini-embedding-001` with 768 dimensions (matches `vector(768)` in `init_db.sql`).
- **Whisper**: The default model is `base`. Use `small` or `medium` for better accuracy at the cost of speed.
- **TTS**: Uses Microsoft Edge TTS voices. Change the voice in `app/voice/tts.py` if needed.
