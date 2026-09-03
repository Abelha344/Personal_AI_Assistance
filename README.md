# Ezric — Personal AI Assistant

Ezric is a **voice- and text-driven personal assistant**. The name comes from the Hebrew root *Ezer* (“my help”). It can chat, speak, and **remember facts you save** in Knowledge (RAG over a vector database).

This repository is a **single FastAPI app**: the UI is static HTML/CSS/JS served by the same server as the API. There is no separate frontend framework.

---

## What it does

- **Conversation** — type messages; Ezric answers using Gemini plus optional memories from Knowledge.
- **Live voice** — tap the mic for a continuous session (listen → think → speak). English is the intended language.
- **Knowledge** — save notes; they are embedded and stored in Neon/pgvector and retrieved when relevant.
- **Greeting** — spoken introduction: *“I am Ezric, your personal AI assistant. How can I help you today?”*

---

## Architecture

```
Browser UI (HTML / CSS / vanilla JS)
  │
  ├─ Typed chat ──────────► POST /chat
  ├─ Live voice (Chrome) ─► Web Speech API (STT)
  │                           └─► POST /chat (voice_mode)
  │                                 └─► speechSynthesis or POST /tts
  └─ Fallback voice ──────► MediaRecorder ► POST /voice
                              (faster-whisper STT on the server)

POST /chat or /voice
  │
  ▼
FastAPI  (Uvicorn)
  │
  ▼
LangGraph  (retrieve → generate)
  │
  ├─ Retrieve: Gemini embeddings + Neon PostgreSQL + pgvector
  └─ Generate: Gemini (google-genai)
  │
  ▼
JSON reply  and/or  TTS audio (edge-tts)
```

---

## Technology stack (everything used to build this system)

### Language and backend
| Technology | Role |
|------------|------|
| **Python 3** | Application language |
| **FastAPI** | REST API and static file hosting |
| **Uvicorn** | ASGI server |
| **Pydantic** / **pydantic-settings** | Request models and `.env` configuration |
| **python-multipart** | Audio uploads for `/voice` |
| **httpx** | HTTP client (dependency) |

### AI, agent, and RAG
| Technology | Role |
|------------|------|
| **Google Gemini** (`google-genai`) | LLM answers (default alias `gemini-flash-latest`, with fallbacks) |
| **Gemini embeddings** (`gemini-embedding-001`) | 768-dimensional vectors for memory search |
| **LangGraph** | Graph: retrieve context → generate reply |
| **langchain-core** / **langchain-google-genai** | LangChain-related dependencies |

### Database and memory
| Technology | Role |
|------------|------|
| **PostgreSQL** | Relational store for documents |
| **Neon** | Hosted Postgres |
| **pgvector** | Vector similarity search (HNSW / IVFFlat as configured in SQL) |
| **psycopg 3** + pool | Database driver and connections |
| **`scripts/init_db.sql`** | Schema: documents table, `vector(768)`, indexes |

### Speech
| Technology | Role |
|------------|------|
| **Web Speech API** (`SpeechRecognition`) | Browser English speech-to-text (primary live-voice path) |
| **Web Speech API** (`speechSynthesis`) | Browser text-to-speech (primary spoken replies) |
| **MediaRecorder** + **Web Audio API** | Mic capture, VAD, waveform (fallback / visualization) |
| **getUserMedia** | Microphone permission |
| **faster-whisper** | Server-side STT (`tiny` by default; used when browser STT is not available) |
| **edge-tts** | Server-side TTS (Microsoft neural voices; greeting `/greeting` and `/tts` backup) |

### Frontend
| Technology | Role |
|------------|------|
| **HTML5** | Pages and voice overlay |
| **CSS3** | Dark UI, mobile drawer, voice session styles |
| **Vanilla JavaScript** | Chat, Knowledge, live voice session (`app.js`, `voice-session.js`) |
| **Google Fonts** | DM Sans, Instrument Serif |
| **Canvas** | Live waveform in the voice overlay |

### Hosting, source control, and config
| Technology | Role |
|------------|------|
| **Git / GitHub** | Version control |
| **Render** | Deploy FastAPI as a web service (`PORT`, env vars) |
| **`.env` / `.env.example`** | Secrets and model names (`.env` is gitignored) |

---

## Project layout

```
app/
  main.py                 FastAPI routes
  config.py               Settings from env
  graph/                  LangGraph retrieve → generate
  llm/gemini.py           Gemini generation + fallbacks
  retrieval/              Embeddings + Neon vector store
  voice/stt.py            faster-whisper
  voice/tts.py            edge-tts
  static/                 UI (index.html, css, js)
scripts/init_db.sql       Neon + pgvector schema
requirements.txt
.env.example
```

---

## Setup (local)

1. **Install (Ubuntu/Debian: use `python3`)**

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   .venv/bin/pip install -r requirements.txt
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Set at least:

   | Variable | Purpose |
   |----------|---------|
   | `GOOGLE_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |
   | `DATABASE_URL` | Neon connection string (`sslmode=require`) |
   | `GEMINI_MODEL` | e.g. `gemini-flash-latest` |
   | `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-001` |
   | `WHISPER_MODEL` | `tiny` (faster) or `base` (clearer) |
   | `WHISPER_LANGUAGE` | `en` |
   | `TOP_K` | How many memories to retrieve (default `5`) |

3. **Initialize Neon**

   - Create a Neon project and enable **pgvector**.
   - Run `scripts/init_db.sql` in the Neon SQL editor.

4. **Run the server**

   Ports 8000/8001 are often taken. Default here is **8010**:

   ```bash
   source .venv/bin/activate
   .venv/bin/uvicorn app.main:app --reload --port 8010
   ```

   UI: http://127.0.0.1:8010  
   Or `./run.sh` (picks a free port if 8010 is busy).

---

## Deploy (Render)

One service hosts **UI + API**.

- **Build:** `pip install -r requirements.txt`
- **Start:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Set the same env vars as `.env` in **Render → Environment** (no `.env` file on the server).
- Free instances **sleep when idle**; the first request after idle can take ~50+ seconds.

---

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web UI |
| `/health` | GET | Status; `configured` if API key + DB URL look set |
| `/greeting` | GET | Spoken intro (MP3) |
| `/chat` | POST | JSON `{ "message", "voice_mode?", "already_greeted?" }` |
| `/voice` | POST | Multipart audio → STT → agent → JSON or MP3 |
| `/tts` | POST | JSON `{ "text" }` → MP3 |
| `/documents` | POST | Save a memory `{ "content", "metadata?" }` |
| `/docs` | GET | OpenAPI |

### Text chat

```bash
curl -X POST http://localhost:8010/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "When is my meeting?"}'
```

### Save a memory

```bash
curl -X POST http://localhost:8010/documents \
  -H "Content-Type: application/json" \
  -d '{"content": "My meeting is every Monday at 9am.", "metadata": {"type": "calendar"}}'
```

### Voice (server STT)

```bash
curl -X POST http://localhost:8010/voice \
  -F "audio=@question.wav" \
  -F "return_audio=true" \
  --output response.mp3
```

---

## Notes and limits

- **Embeddings** must stay **768 dimensions** to match `vector(768)` in `init_db.sql`.
- **Gemini free-tier** keys have request/token quotas (RPM / TPM / RPD). Hitting them returns busy/unavailable-style errors. Model names also change; the app falls back across several Flash aliases.
- **Live voice** works best in **Chrome**. Browser STT/TTS avoid loading Whisper on small hosts (e.g. Render free 512 MB).
- **TTS fallback** uses Edge voices (default `en-US-AriaNeural` in `app/voice/tts.py`).
- **Do not commit `.env`.** Each deployer needs their own Gemini key and Neon database.
- This build is a **single-user** assistant: anyone with the URL shares the same Knowledge unless you add login later.

---

## License / use

Personal and educational use. You need accounts for **Google AI Studio**, **Neon**, and (if deployed) **Render** — those services have their own terms and free-tier limits.
