const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const messagesEl = $("#messages");
const messageInput = $("#messageInput");
const sendBtn = $("#sendBtn");
const micBtn = $("#micBtn");
const clearChat = $("#clearChat");
const statusCard = $("#statusCard");
const statusLabel = $("#statusLabel");
const statusDetail = $("#statusDetail");
const docContent = $("#docContent");
const docTag = $("#docTag");
const saveDoc = $("#saveDoc");
const toasts = $("#toasts");
const sidebar = $("#sidebar");
const drawerBackdrop = $("#drawerBackdrop");
const menuBtn = $("#menuBtn");
const drawerClose = $("#drawerClose");
const mobileStatusDot = $("#mobileStatusDot");
const mobileClearChat = $("#mobileClearChat");

let isLoading = false;
let welcomeRemoved = false;

const isMobile = () => window.matchMedia("(max-width: 900px)").matches;

const voiceSession = new VoiceSession({
  onTranscript: (query, response) => {
    if (query) addMessage("user", query);
    if (response) addMessage("assistant", response);
  },
  onError: (msg) => toast(msg, "error"),
  onStateChange: (state) => {
    micBtn?.classList.toggle("live", Boolean(state));
  },
});

async function toggleVoiceSession() {
  if (voiceSession.isActive) {
    voiceSession.stop();
    updateComposerHint();
    return;
  }
  switchPanel("chat");
  await voiceSession.start();
  updateComposerHint();
}

// ── Status ──────────────────────────────────────────────
async function checkHealth() {
  try {
    const res = await fetch("/health");
    const data = await res.json();
    statusCard.classList.remove("online", "warning");
    mobileStatusDot?.classList.remove("online", "warning");
    if (data.configured) {
      statusCard.classList.add("online");
      mobileStatusDot?.classList.add("online");
      statusLabel.textContent = "Ready";
      statusDetail.textContent = "All systems connected";
    } else {
      statusCard.classList.add("warning");
      mobileStatusDot?.classList.add("warning");
      statusLabel.textContent = "Setup needed";
      statusDetail.textContent = "Add API keys in .env";
    }
  } catch {
    statusCard.classList.remove("online", "warning");
    mobileStatusDot?.classList.remove("online", "warning");
    statusLabel.textContent = "Offline";
    statusDetail.textContent = "Server not reachable";
  }
}

// ── Drawer ──────────────────────────────────────────────
function openDrawer() {
  sidebar?.classList.add("open");
  drawerBackdrop?.classList.add("visible");
  document.body.style.overflow = "hidden";
}

function closeDrawer() {
  sidebar?.classList.remove("open");
  drawerBackdrop?.classList.remove("visible");
  document.body.style.overflow = "";
}

// ── Navigation ──────────────────────────────────────────
function switchPanel(panel) {
  $$(".nav-btn, .mobile-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.panel === panel);
  });
  $$(".panel").forEach((p) => p.classList.remove("active"));
  $(`#panel-${panel}`)?.classList.add("active");
  if (mobileClearChat) {
    mobileClearChat.style.visibility = panel === "chat" ? "visible" : "hidden";
  }
  closeDrawer();
}

$$(".nav-btn, .mobile-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchPanel(btn.dataset.panel));
});

menuBtn?.addEventListener("click", openDrawer);
drawerClose?.addEventListener("click", closeDrawer);
drawerBackdrop?.addEventListener("click", closeDrawer);

// ── Messages ────────────────────────────────────────────
function removeWelcome() {
  if (!welcomeRemoved) {
    const w = $(".welcome");
    if (w) w.remove();
    welcomeRemoved = true;
  }
}

function formatTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function addMessage(role, text) {
  removeWelcome();
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.innerHTML = `
    <div class="message-avatar">${role === "user" ? "You" : "Ez"}</div>
    <div>
      <div class="message-body">${escapeHtml(text)}</div>
      <div class="message-time">${formatTime()}</div>
    </div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addTyping() {
  removeWelcome();
  const div = document.createElement("div");
  div.className = "message assistant";
  div.id = "typing";
  div.innerHTML = `
    <div class="message-avatar">Ez</div>
    <div class="message-body"><div class="typing"><span></span><span></span><span></span></div></div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function removeTyping() {
  const t = $("#typing");
  if (t) t.remove();
}

function escapeHtml(text) {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML.replace(/\n/g, "<br>");
}

// ── Chat ────────────────────────────────────────────────
function syncSendBtn() {
  if (!sendBtn || !messageInput) return;
  const empty = !messageInput.value.trim();
  sendBtn.classList.toggle("is-empty", empty);
  sendBtn.classList.toggle("is-loading", isLoading);
}

async function sendMessage(text) {
  const msg = (text ?? messageInput?.value ?? "").trim();
  if (!msg || isLoading) return;

  isLoading = true;
  syncSendBtn();
  if (messageInput) {
    messageInput.value = "";
    autoResize();
  }

  addMessage("user", msg);
  addTyping();

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg }),
    });

    removeTyping();

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const detail = typeof err.detail === "string"
        ? err.detail
        : `Error ${res.status}. Check your .env configuration.`;
      addMessage("assistant", detail);
      toast(detail, "error");
      return;
    }

    const data = await res.json();
    addMessage("assistant", data.response);
  } catch (e) {
    removeTyping();
    addMessage("assistant", "Could not reach the server. Make sure it is running.");
    toast("Connection failed", "error");
  } finally {
    isLoading = false;
    syncSendBtn();
  }
}

// ── Knowledge ───────────────────────────────────────────
function setKnowledgeStatus(message, type = "") {
  const el = $("#knowledgeStatus");
  if (!el) return;
  el.textContent = message || "";
  el.className = `knowledge-status ${type}`.trim();
}

async function saveDocument() {
  const content = docContent.value.trim();
  if (!content) {
    setKnowledgeStatus("Write a memory before saving.", "error");
    return;
  }

  saveDoc.disabled = true;
  setKnowledgeStatus("Saving…", "pending");
  const metadata = docTag.value.trim() ? { tag: docTag.value.trim() } : null;

  try {
    const res = await fetch("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, metadata }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const detail = typeof err.detail === "string"
        ? err.detail
        : "Failed to save. Check Neon DATABASE_URL password.";
      setKnowledgeStatus(detail, "error");
      toast(detail, "error");
      return;
    }

    docContent.value = "";
    docTag.value = "";
    setKnowledgeStatus("Saved to Neon memory.", "success");
    toast("Memory saved successfully", "success");
  } catch {
    setKnowledgeStatus("Failed to save memory. Is the server running?", "error");
    toast("Failed to save memory", "error");
  } finally {
    saveDoc.disabled = false;
  }
}

// ── Toast ───────────────────────────────────────────────
function toast(msg, type = "") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  toasts.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Input helpers ───────────────────────────────────────
function autoResize() {
  if (!messageInput) return;
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
}

// ── Events ──────────────────────────────────────────────
const chatForm = $("#chatForm");

function onComposerInput() {
  autoResize();
  syncSendBtn();
}

if (messageInput) {
  ["input", "keyup", "change"].forEach((evt) => {
    messageInput.addEventListener(evt, onComposerInput);
  });
  messageInput.addEventListener("paste", () => setTimeout(onComposerInput, 0));
  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(messageInput.value);
    }
  });
}

if (chatForm) {
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage(messageInput?.value);
  });
}

if (sendBtn) {
  sendBtn.addEventListener("click", (e) => {
    e.preventDefault();
    sendMessage(messageInput?.value);
  });
}

micBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  toggleVoiceSession();
});

clearChat?.addEventListener("click", resetChat);
mobileClearChat?.addEventListener("click", resetChat);

function resetChat() {
  if (voiceSession.isActive) voiceSession.stop();
  messagesEl.innerHTML = "";
  welcomeRemoved = false;
  messagesEl.innerHTML = `
    <div class="welcome">
      <div class="welcome-orb"><div class="orb-ring"></div><div class="orb-core"></div></div>
      <h3>I am Ezric</h3>
      <p>Your personal AI assistant. Teach me facts in Knowledge, then ask me anything.</p>
      <div class="suggestions">
        <button class="chip" data-prompt="What do you remember about me?">What do you remember?</button>
        <button class="chip" data-prompt="Summarize my schedule">My schedule</button>
        <button class="chip" data-prompt="Help me plan my day">Plan my day</button>
      </div>
    </div>`;
  bindChips();
  updateComposerHint();
}

function updateComposerHint() {
  const hint = $("#composerHint");
  if (!hint) return;
  if (voiceSession.isActive) {
    hint.textContent = "Live voice session active";
    return;
  }
  hint.textContent = isMobile()
    ? "Tap mic for live voice · Enter to send"
    : "Press Enter to send · Tap mic for live voice with Ezric";
}

$$(".chip").forEach((chip) => {
  chip.addEventListener("click", () => sendMessage(chip.dataset.prompt));
});

function bindChips() {
  $$(".chip").forEach((chip) => {
    chip.addEventListener("click", () => sendMessage(chip.dataset.prompt));
  });
}

saveDoc.addEventListener("click", saveDocument);

syncSendBtn();
checkHealth();
setInterval(checkHealth, 30000);
updateComposerHint();
switchPanel("chat");
window.addEventListener("resize", updateComposerHint);
