from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.graph.workflow import agent
from app.retrieval.vector_store import vector_store
from app.voice.stt import transcribe_audio
from app.voice.tts import synthesize_speech

STATIC_DIR = Path(__file__).parent / "static"
EZRIC_GREETING = "I am Ezric, your personal AI assistant. How can I help you today?"


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Preload Whisper so the first live-voice turn is not a long cold start
    try:
        from app.voice.stt import warm_up

        warm_up()
    except Exception:
        pass
    yield
    vector_store.close()


app = FastAPI(
    title="Ezric",
    description="Ezric — Voice → STT → LangGraph → pgvector → Gemini → TTS",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class ChatRequest(BaseModel):
    message: str
    voice_mode: bool = False


class ChatResponse(BaseModel):
    query: str
    response: str


class DocumentRequest(BaseModel):
    content: str
    metadata: dict | None = None


class TTSRequest(BaseModel):
    text: str


@app.get("/", include_in_schema=False)
def root():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
def health() -> dict[str, str | bool]:
    from app.config import settings

    return {
        "status": "ok",
        "configured": settings.is_configured,
    }


@app.get("/greeting")
async def greeting() -> Response:
    """Spoken Ezric introduction for new sessions."""
    try:
        speech = await synthesize_speech(EZRIC_GREETING)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not generate greeting audio: {exc}") from exc
    return Response(
        content=speech,
        media_type="audio/mpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@app.post("/tts")
async def tts(request: TTSRequest) -> Response:
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")
    try:
        speech = await synthesize_speech(text[:2000])
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"TTS failed: {exc}") from exc
    return Response(content=speech, media_type="audio/mpeg")


@app.post("/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    try:
        result = agent.invoke(
            {
                "query": request.message,
                "context": "",
                "response": "",
                "voice_mode": request.voice_mode,
            }
        )
    except Exception as exc:
        detail = str(exc)
        if "API key" in detail:
            detail = "Ezric can't connect right now — API key issue. Please try again later."
        elif "NOT_FOUND" in detail or "no longer available" in detail:
            detail = "Ezric is temporarily unavailable. Please try again shortly."
        elif "UNAVAILABLE" in detail or "high demand" in detail or "503" in detail:
            detail = "Ezric is busy right now. Please try again in a few seconds."
        else:
            detail = "Ezric ran into an issue. Please try again."
        raise HTTPException(status_code=502, detail=detail) from exc
    return ChatResponse(query=request.message, response=result["response"])


@app.post("/voice", response_model=None)
async def voice_chat(
    audio: UploadFile = File(...),
    return_audio: bool = Form(default=True),
):
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio file")

    # Browsers often send webm as application/octet-stream or empty content-type
    filename = audio.filename or "audio.webm"
    content_type = (audio.content_type or "").lower()
    if content_type and not (
        content_type.startswith("audio/")
        or content_type in {"application/octet-stream", "video/webm"}
        or filename.endswith((".webm", ".wav", ".mp3", ".ogg", ".m4a"))
    ):
        raise HTTPException(status_code=400, detail="Expected an audio file")

    try:
        query = transcribe_audio(audio_bytes, filename=filename)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Transcription failed: {exc}") from exc

    if not query:
        raise HTTPException(
            status_code=422,
            detail="Could not understand audio. Please speak clearly and try again.",
        )

    try:
        result = agent.invoke(
            {"query": query, "context": "", "response": "", "voice_mode": True}
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Ezric ran into an issue. Please try again.") from exc

    response_text = result["response"]

    if return_audio:
        speech = await synthesize_speech(response_text)
        return Response(content=speech, media_type="audio/mpeg")

    return ChatResponse(query=query, response=response_text)


@app.post("/documents")
def add_document(request: DocumentRequest) -> dict[str, str]:
    try:
        vector_store.add_document(request.content, request.metadata)
    except Exception as exc:
        detail = str(exc)
        if "password authentication failed" in detail:
            detail = "Neon password is wrong. Copy the full connection string from Neon → Connect into .env DATABASE_URL."
        elif "could not translate host" in detail or "Name or service not known" in detail:
            detail = "Neon host cannot be resolved. Update DATABASE_URL with the current Connect string."
        elif "Network is unreachable" in detail or "PoolTimeout" in detail:
            detail = "Cannot reach Neon. Check DATABASE_URL and network, then restart the server."
        else:
            detail = f"Failed to save memory: {detail}"
        raise HTTPException(status_code=502, detail=detail) from exc
    return {"status": "indexed"}
