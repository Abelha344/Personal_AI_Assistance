/**
 * Continuous live voice session (ChatGPT Voice Mode style).
 * Client keeps the mic open with VAD; each utterance is POSTed to /voice,
 * then Ezric replies via /tts. Barge-in stops TTS when the user speaks again.
 */
(function (global) {
  const STATES = {
    LISTENING: "listening",
    THINKING: "thinking",
    SPEAKING: "speaking",
  };

  const SPEECH_THRESHOLD = 0.025;
  const SILENCE_MS = 900;
  const MIN_SPEECH_MS = 450;
  const BARGE_IN_THRESHOLD = 0.045;
  const BARGE_IN_HOLD_MS = 220;

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
      this.bargeHoldStarted = 0;
      this.level = 0;

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
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.active) this.stop();
      });
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
      this._showOverlay(true);
      this._setState(STATES.LISTENING, "Listening…", "Say something — Ezric is listening");
      this.transcriptEl.textContent = "";

      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.sourceNode.connect(this.analyser);

      this._startRecorder();
      this._tick();

      // Unlock audio + short greeting inside the user gesture chain
      try {
        const greet = new Audio("/greeting");
        this._setState(STATES.SPEAKING, "Speaking…", "Ezric is introducing…");
        await greet.play();
        await new Promise((resolve) => {
          greet.onended = resolve;
          greet.onerror = resolve;
        });
      } catch {
        /* autoplay / network — continue listening */
      }

      if (this.active) {
        this._setState(STATES.LISTENING, "Listening…", "Say something — Ezric is listening");
      }
    }

    stop() {
      this.active = false;
      this.processing = false;
      this._cancelRaf();
      this._stopTts();
      this._stopRecorder();

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

    _startRecorder() {
      if (!this.stream || !this.active) return;
      this.chunks = [];
      this.hadSpeech = false;
      this.speechStartedAt = 0;
      this.silenceStartedAt = 0;

      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      try {
        this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: mime });
      } catch {
        this.mediaRecorder = new MediaRecorder(this.stream);
      }

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data);
      };

      this.mediaRecorder.onstop = () => {
        if (!this.active || this.processing) return;
        const blob = new Blob(this.chunks, { type: this.mediaRecorder.mimeType || "audio/webm" });
        this.chunks = [];
        if (blob.size < 1200 || !this.hadSpeech) {
          if (this.active && this.state === STATES.LISTENING) this._startRecorder();
          return;
        }
        this._handleUtterance(blob);
      };

      this.mediaRecorder.start(200);
    }

    _stopRecorder() {
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        try { this.mediaRecorder.stop(); } catch { /* ignore */ }
      }
      this.mediaRecorder = null;
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

      if (this.state === STATES.SPEAKING) {
        if (level > BARGE_IN_THRESHOLD) {
          if (!this.bargeHoldStarted) this.bargeHoldStarted = now;
          else if (now - this.bargeHoldStarted > BARGE_IN_HOLD_MS) {
            this._stopTts();
            this.bargeHoldStarted = 0;
            this._setState(STATES.LISTENING, "Listening…", "I’m listening — go ahead");
            this._startRecorder();
          }
        } else {
          this.bargeHoldStarted = 0;
        }
      } else if (this.state === STATES.LISTENING && this.mediaRecorder?.state === "recording") {
        if (level > SPEECH_THRESHOLD) {
          if (!this.hadSpeech) {
            this.hadSpeech = true;
            this.speechStartedAt = now;
          }
          this.silenceStartedAt = 0;
        } else if (this.hadSpeech) {
          if (!this.silenceStartedAt) this.silenceStartedAt = now;
          const spokeLongEnough = now - this.speechStartedAt >= MIN_SPEECH_MS;
          const silentLongEnough = now - this.silenceStartedAt >= SILENCE_MS;
          if (spokeLongEnough && silentLongEnough) {
            this._stopRecorder();
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
        const scale = 1 + Math.min(level * 4, 0.35);
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
      this._setState(STATES.THINKING, "Processing…", "Ezric is thinking…");

      try {
        const form = new FormData();
        form.append("audio", blob, "utterance.webm");
        form.append("return_audio", "false");

        const res = await fetch("/voice", { method: "POST", body: form });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || "Voice request failed");
        }

        const data = await res.json();
        this.onTranscript(data.query, data.response);
        if (this.transcriptEl) {
          this.transcriptEl.textContent = data.query ? `You: ${data.query}` : "";
        }

        if (!this.active) return;
        await this._speak(data.response);
      } catch (e) {
        this.onError(e.message || "Voice session error");
        if (this.active) {
          this._setState(STATES.LISTENING, "Listening…", "Try again — Ezric is listening");
          this._startRecorder();
        }
      } finally {
        this.processing = false;
      }
    }

    async _speak(text) {
      if (!this.active || !text) {
        if (this.active) {
          this._setState(STATES.LISTENING, "Listening…", "Say something — Ezric is listening");
          this._startRecorder();
        }
        return;
      }

      this._setState(STATES.SPEAKING, "Speaking…", "Ezric is speaking — interrupt anytime");
      this.bargeHoldStarted = 0;

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
        this.ttsAudio = new Audio(url);
        await new Promise((resolve) => {
          const done = () => {
            URL.revokeObjectURL(url);
            resolve();
          };
          this.ttsAudio.onended = done;
          this.ttsAudio.onerror = done;
          this.ttsAudio.play().catch(done);
        });
      } catch {
        /* fall through to listening */
      }

      this._stopTts();
      if (this.active) {
        this._setState(STATES.LISTENING, "Listening…", "Say something — Ezric is listening");
        this._startRecorder();
      }
    }

    _stopTts() {
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
