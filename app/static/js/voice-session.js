/**
 * Continuous live voice session.
 * Fast path: browser SpeechRecognition (EN) → POST /chat (RAG/memory) → speechSynthesis.
 * Fallback: MediaRecorder → POST /voice (Whisper) → /tts when browser STT is unavailable.
 */
(function (global) {
  const STATES = {
    LISTENING: "listening",
    THINKING: "thinking",
    SPEAKING: "speaking",
  };

  const SPEECH_THRESHOLD = 0.012;
  const SILENCE_MS = 900;
  const MIN_SPEECH_MS = 350;
  const BARGE_IN_THRESHOLD = 0.05;
  const BARGE_IN_HOLD_MS = 280;
  const MAX_UTTERANCE_MS = 20000;
  const GREETING = "I am Ezric, your personal AI assistant. How can I help you today?";

  /** Strip markdown / symbols so TTS does not say "hash hash" or "dash dash". */
  function plainSpeechText(raw) {
    if (!raw) return "";
    return String(raw)
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^#{1,6}\s*/gm, "")
      .replace(/^\s*[-*_]{3,}\s*$/gm, " ")
      .replace(/\|/g, " ")
      .replace(/:?-{3,}:?/g, " ")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[#>~`|]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const SpeechRecognition =
    global.SpeechRecognition || global.webkitSpeechRecognition || null;

  class VoiceSession {
    constructor(options = {}) {
      this.onTranscript = options.onTranscript || (() => {});
      this.onError = options.onError || (() => {});
      this.onStateChange = options.onStateChange || (() => {});

      this.active = false;
      this.state = STATES.LISTENING;
      this.stream = null;
      this.audioCtx = null;
      this.analyser = null;
      this.sourceNode = null;
      this.mediaRecorder = null;
      this.chunks = [];
      this.rafId = null;
      this.speechStartedAt = 0;
      this.silenceStartedAt = 0;
      this.hadSpeech = false;
      this.processing = false;
      this.ttsAudio = null;
      this.utterance = null;
      this.bargeHoldStarted = 0;
      this.level = 0;
      this.vadEnabled = false;
      this._recorderGeneration = 0;
      this.useBrowserStt = Boolean(SpeechRecognition);
      this.recognition = null;
      this._finalBuffer = "";

      this.overlay = document.getElementById("voiceOverlay");
      this.aura = document.getElementById("voiceAura");
      this.core = document.getElementById("voiceCore");
      this.stateLabel = document.getElementById("voiceStateLabel");
      this.caption = document.getElementById("voiceCaption");
      this.transcriptEl = document.getElementById("voiceTranscript");
      this.waveCanvas = document.getElementById("voiceWave");
      this.stopBtn = document.getElementById("voiceStopBtn");
      this.waveCtx = this.waveCanvas?.getContext("2d") || null;

      this.stopBtn?.addEventListener("click", () => this.stop());
      this.aura?.addEventListener("click", () => this._forceSendIfListening());
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.active) this.stop();
      });
    }

    _forceSendIfListening() {
      if (!this.active || this.state !== STATES.LISTENING || !this.vadEnabled) return;
      if (this.useBrowserStt) {
        const text = this._finalBuffer.trim();
        if (text) this._submitText(text);
        return;
      }
      if (this.mediaRecorder?.state === "recording" && this.hadSpeech) {
        this._stopRecorder(true);
      }
    }

    get isActive() {
      return this.active;
    }

    async start() {
      if (this.active) return;

      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch {
        this.onError("Microphone access denied");
        return;
      }

      this.active = true;
      this.processing = false;
      this.vadEnabled = false;
      this._showOverlay(true);
      this._setState(STATES.LISTENING, "Starting…", "Getting ready…");
      if (this.transcriptEl) this.transcriptEl.textContent = "";

      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioCtx.state === "suspended") {
        await this.audioCtx.resume().catch(() => {});
      }
      this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.sourceNode.connect(this.analyser);
      this._tick();

      await this._playGreeting();

      if (!this.active) return;
      this.vadEnabled = true;
      this._setState(
        STATES.LISTENING,
        "Listening…",
        this.useBrowserStt
          ? "Say something — English, fast mode"
          : "Say something — Ezric is listening"
      );
      this._startListening();
    }

    stop() {
      this.active = false;
      this.processing = false;
      this.vadEnabled = false;
      this._cancelRaf();
      this._stopTts();
      this._stopBrowserRecognition();
      this._stopRecorder(false);

      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
      if (this.sourceNode) {
        try { this.sourceNode.disconnect(); } catch { /* ignore */ }
        this.sourceNode = null;
      }
      if (this.audioCtx) {
        this.audioCtx.close().catch(() => {});
        this.audioCtx = null;
      }
      this.analyser = null;
      this._showOverlay(false);
      this._setState(STATES.LISTENING, "Listening…", "");
      this.onStateChange(null);
    }

    async _playGreeting() {
      this._setState(STATES.SPEAKING, "Speaking…", "Ezric is introducing…");
      // Prefer instant browser TTS for greeting (much faster than /greeting download)
      if ("speechSynthesis" in global) {
        try {
          await this._speakBrowser(GREETING);
          return;
        } catch { /* fall through */ }
      }
      try {
        const greet = new Audio("/greeting");
        this.ttsAudio = greet;
        await greet.play();
        await new Promise((resolve) => {
          greet.onended = () => resolve();
          greet.onerror = () => resolve();
        });
      } catch {
        /* continue without intro audio */
      } finally {
        if (this.ttsAudio) this.ttsAudio = null;
      }
    }

    _showOverlay(show) {
      if (!this.overlay) return;
      if (show) {
        this.overlay.hidden = false;
        this.overlay.setAttribute("aria-hidden", "false");
        document.body.style.overflow = "hidden";
      } else {
        this.overlay.hidden = true;
        this.overlay.setAttribute("aria-hidden", "true");
        document.body.style.overflow = "";
      }
    }

    _setState(state, badge, caption) {
      this.state = state;
      if (this.overlay) this.overlay.dataset.state = state;
      if (this.aura) this.aura.dataset.state = state;
      if (this.stateLabel) this.stateLabel.textContent = badge;
      if (this.caption && caption != null) this.caption.textContent = caption;
      this.onStateChange(state);
    }

    _startListening() {
      if (this.useBrowserStt) this._startBrowserRecognition();
      else this._startRecorder();
    }

    _startBrowserRecognition() {
      if (!SpeechRecognition || !this.active || this.processing) return;
      this._stopBrowserRecognition();
      this._finalBuffer = "";

      const recognition = new SpeechRecognition();
      recognition.lang = "en-US";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event) => {
        if (!this.active || this.processing || this.state !== STATES.LISTENING) return;
        let interim = "";
        let finals = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const piece = event.results[i][0]?.transcript || "";
          if (event.results[i].isFinal) finals += piece;
          else interim += piece;
        }
        if (finals) this._finalBuffer = `${this._finalBuffer} ${finals}`.trim();
        const preview = (this._finalBuffer || interim).trim();
        if (preview && this.caption) {
          this.caption.textContent = `Hearing: ${preview}`;
        }
        // End of a phrase: submit final chunk
        if (finals.trim()) {
          const text = this._finalBuffer.trim();
          this._finalBuffer = "";
          this._submitText(text);
        }
      };

      recognition.onerror = (event) => {
        if (!this.active) return;
        if (event.error === "aborted" || event.error === "no-speech") return;
        if (event.error === "not-allowed") {
          this.onError("Microphone / speech recognition blocked");
          return;
        }
        // Network or other errors: fall back to Whisper path for this session
        if (event.error === "network" || event.error === "service-not-allowed") {
          this.useBrowserStt = false;
          this._stopBrowserRecognition();
          if (this.state === STATES.LISTENING && this.vadEnabled && !this.processing) {
            this._setState(STATES.LISTENING, "Listening…", "Fallback mode — pause when finished");
            this._startRecorder();
          }
        }
      };

      recognition.onend = () => {
        if (!this.active || !this.useBrowserStt) return;
        if (this.processing || this.state !== STATES.LISTENING || !this.vadEnabled) return;
        try {
          recognition.start();
        } catch { /* already started */ }
      };

      this.recognition = recognition;
      try {
        recognition.start();
      } catch {
        this.useBrowserStt = false;
        this._startRecorder();
      }
    }

    _stopBrowserRecognition() {
      const rec = this.recognition;
      this.recognition = null;
      if (!rec) return;
      try {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.abort();
      } catch { /* ignore */ }
    }

    async _submitText(text) {
      const query = (text || "").trim();
      if (!query || !this.active || this.processing) return;

      this.processing = true;
      this.vadEnabled = false;
      this._stopBrowserRecognition();
      this._setState(STATES.THINKING, "Processing…", "Ezric is thinking…");

      try {
        // Same RAG / knowledge path as typed chat — memories still apply
        const res = await fetch("/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: query, voice_mode: true }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          const detail = typeof err.detail === "string" ? err.detail : "Chat failed";
          throw new Error(detail);
        }
        const data = await res.json();
        this.onTranscript(data.query || query, data.response);
        if (this.transcriptEl) {
          const lines = [];
          if (data.query || query) lines.push(`You: ${data.query || query}`);
          if (data.response) lines.push(`Ezric: ${plainSpeechText(data.response)}`);
          this.transcriptEl.textContent = lines.join("\n");
        }
        if (!this.active) return;
        await this._speak(data.response);
      } catch (e) {
        this.onError(e.message || "Voice session error");
        if (this.active) {
          this.vadEnabled = true;
          this._setState(STATES.LISTENING, "Listening…", "Try again — Ezric is listening");
          this._startListening();
        }
      } finally {
        this.processing = false;
      }
    }

    _startRecorder() {
      if (!this.stream || !this.active || this.processing) return;

      this._stopRecorder(false);

      this.chunks = [];
      this.hadSpeech = false;
      this.speechStartedAt = 0;
      this.silenceStartedAt = 0;
      const generation = ++this._recorderGeneration;

      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";

      let recorder;
      try {
        recorder = mime
          ? new MediaRecorder(this.stream, { mimeType: mime })
          : new MediaRecorder(this.stream);
      } catch {
        recorder = new MediaRecorder(this.stream);
      }

      this.mediaRecorder = recorder;

      recorder.ondataavailable = (e) => {
        if (generation !== this._recorderGeneration) return;
        if (e.data && e.data.size > 0) this.chunks.push(e.data);
      };

      recorder.onstop = () => {
        if (generation !== this._recorderGeneration) return;
        if (!this.active || this.processing) return;

        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(this.chunks, { type: mimeType });
        this.chunks = [];

        if (blob.size < 800 || !this.hadSpeech) {
          if (this.active && this.state === STATES.LISTENING && this.vadEnabled) {
            this._startRecorder();
          }
          return;
        }

        this._handleUtterance(blob);
      };

      try {
        recorder.start(250);
      } catch {
        this.onError("Could not start microphone recording");
      }
    }

    _stopRecorder(triggerUtterance = true) {
      const recorder = this.mediaRecorder;
      this.mediaRecorder = null;
      if (!recorder) return;
      if (recorder.state === "inactive") return;
      try {
        if (!triggerUtterance) this._recorderGeneration += 1;
        recorder.stop();
      } catch { /* ignore */ }
    }

    _rms() {
      if (!this.analyser) return 0;
      const data = new Uint8Array(this.analyser.fftSize);
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / data.length);
    }

    _tick() {
      if (!this.active) return;
      const level = this._rms();
      this.level = level;
      this._drawWave(level);
      this._scaleCore(level);

      const now = performance.now();

      if (this.state === STATES.SPEAKING && this.vadEnabled) {
        if ((this.ttsAudio || this.utterance) && level > BARGE_IN_THRESHOLD) {
          if (!this.bargeHoldStarted) this.bargeHoldStarted = now;
          else if (now - this.bargeHoldStarted > BARGE_IN_HOLD_MS) {
            this._stopTts();
            this.bargeHoldStarted = 0;
            this._setState(STATES.LISTENING, "Listening…", "I’m listening — go ahead");
            this._startListening();
          }
        } else {
          this.bargeHoldStarted = 0;
        }
      } else if (
        !this.useBrowserStt &&
        this.state === STATES.LISTENING &&
        this.vadEnabled &&
        this.mediaRecorder?.state === "recording"
      ) {
        if (level > SPEECH_THRESHOLD) {
          if (!this.hadSpeech) {
            this.hadSpeech = true;
            this.speechStartedAt = now;
            if (this.caption) this.caption.textContent = "Hearing you…";
          }
          this.silenceStartedAt = 0;
          if (now - this.speechStartedAt >= MAX_UTTERANCE_MS) {
            this._stopRecorder(true);
          }
        } else if (this.hadSpeech) {
          if (!this.silenceStartedAt) this.silenceStartedAt = now;
          const spokeLongEnough = now - this.speechStartedAt >= MIN_SPEECH_MS;
          const silentLongEnough = now - this.silenceStartedAt >= SILENCE_MS;
          if (spokeLongEnough && silentLongEnough) {
            this._stopRecorder(true);
          }
        }
      }

      this.rafId = requestAnimationFrame(() => this._tick());
    }

    _cancelRaf() {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    _scaleCore(level) {
      if (!this.core) return;
      if (this.state === STATES.LISTENING) {
        const scale = 1 + Math.min(level * 5, 0.4);
        this.core.style.transform = `scale(${scale})`;
      } else if (this.state === STATES.SPEAKING) {
        const scale = 1 + Math.min(level * 2.5, 0.28);
        this.core.style.transform = `scale(${scale})`;
      } else {
        this.core.style.transform = "";
      }
    }

    _drawWave(level) {
      if (!this.waveCanvas || !this.waveCtx) return;
      const ctx = this.waveCtx;
      const w = this.waveCanvas.width;
      const h = this.waveCanvas.height;
      ctx.clearRect(0, 0, w, h);

      if (this.state !== STATES.LISTENING && this.state !== STATES.SPEAKING) return;

      const bars = 28;
      const gap = 4;
      const barW = (w - gap * (bars - 1)) / bars;
      const color = this.state === STATES.SPEAKING ? "#38bdf8" : "#6ee7b7";
      ctx.fillStyle = color;

      for (let i = 0; i < bars; i++) {
        const t = Date.now() / 180 + i * 0.45;
        const ambient = (Math.sin(t) + 1) / 2;
        const height = Math.max(4, (0.15 + level * 3.5 + ambient * 0.25) * h * 0.7);
        const x = i * (barW + gap);
        const y = (h - height) / 2;
        if (ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(x, y, barW, height, 3);
          ctx.fill();
        } else {
          ctx.fillRect(x, y, barW, height);
        }
      }
    }

    async _handleUtterance(blob) {
      if (!this.active) return;
      this.processing = true;
      this.vadEnabled = false;
      this._setState(STATES.THINKING, "Processing…", "Transcribing (English)…");

      try {
        const form = new FormData();
        form.append("audio", blob, "utterance.webm");
        form.append("return_audio", "false");

        const res = await fetch("/voice", { method: "POST", body: form });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          const detail = typeof err.detail === "string" ? err.detail : "Voice request failed";
          throw new Error(detail);
        }

        const data = await res.json();
        this._setState(STATES.THINKING, "Processing…", "Ezric is thinking…");
        this.onTranscript(data.query, data.response);
        if (this.transcriptEl) {
          const lines = [];
          if (data.query) lines.push(`You: ${data.query}`);
          if (data.response) lines.push(`Ezric: ${plainSpeechText(data.response)}`);
          this.transcriptEl.textContent = lines.join("\n");
        }

        if (!this.active) return;
        await this._speak(data.response);
      } catch (e) {
        this.onError(e.message || "Voice session error");
        if (this.active) {
          this.vadEnabled = true;
          this._setState(STATES.LISTENING, "Listening…", "Try again — Ezric is listening");
          this._startListening();
        }
      } finally {
        this.processing = false;
      }
    }

    async _speak(text) {
      if (!this.active || !text) {
        if (this.active) {
          this.vadEnabled = true;
          this._setState(STATES.LISTENING, "Listening…", "Say something — Ezric is listening");
          this._startListening();
        }
        return;
      }

      const spoken = plainSpeechText(text);
      this._setState(STATES.SPEAKING, "Speaking…", "Ezric is speaking — tap Stop to end");
      this.bargeHoldStarted = 0;
      this.vadEnabled = true;

      // Instant local TTS first (big speed win); edge-tts only as backup
      if ("speechSynthesis" in global) {
        try {
          await this._speakBrowser(spoken);
        } catch {
          await this._speakEdge(spoken);
        }
      } else {
        await this._speakEdge(spoken);
      }

      this._stopTts();
      if (this.active) {
        this.vadEnabled = true;
        this._setState(STATES.LISTENING, "Listening…", "Say something — Ezric is listening");
        this._startListening();
      }
    }

    _speakBrowser(text) {
      return new Promise((resolve, reject) => {
        try {
          global.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(text);
          u.lang = "en-US";
          u.rate = 1.05;
          const voices = global.speechSynthesis.getVoices();
          const en = voices.find((v) => v.lang?.startsWith("en") && /female|aria|jenny|samantha|google us/i.test(v.name))
            || voices.find((v) => v.lang?.startsWith("en"));
          if (en) u.voice = en;
          this.utterance = u;
          u.onend = () => {
            this.utterance = null;
            resolve();
          };
          u.onerror = () => {
            this.utterance = null;
            reject(new Error("speechSynthesis failed"));
          };
          // Chrome sometimes needs voices loaded
          if (!voices.length) {
            global.speechSynthesis.onvoiceschanged = () => {
              const later = global.speechSynthesis.getVoices();
              const pick = later.find((v) => v.lang?.startsWith("en")) || null;
              if (pick) u.voice = pick;
              global.speechSynthesis.speak(u);
            };
          } else {
            global.speechSynthesis.speak(u);
          }
        } catch (e) {
          reject(e);
        }
      });
    }

    async _speakEdge(text) {
      try {
        const res = await fetch("/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error("TTS failed");
        const buf = await res.arrayBuffer();
        if (!this.active) return;

        const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
        const audio = new Audio(url);
        this.ttsAudio = audio;
        await new Promise((resolve) => {
          const done = () => {
            URL.revokeObjectURL(url);
            resolve();
          };
          audio.onended = done;
          audio.onerror = done;
          audio.play().catch(done);
        });
      } catch {
        /* fall through */
      }
    }

    _stopTts() {
      if (this.utterance) {
        try { global.speechSynthesis.cancel(); } catch { /* ignore */ }
        this.utterance = null;
      }
      if (this.ttsAudio) {
        try {
          this.ttsAudio.pause();
          this.ttsAudio.src = "";
        } catch { /* ignore */ }
        this.ttsAudio = null;
      }
    }
  }

  global.VoiceSession = VoiceSession;
  global.VOICE_STATES = STATES;
})(window);
