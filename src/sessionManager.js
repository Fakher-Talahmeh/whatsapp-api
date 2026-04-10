const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");

const sessions = new Map();
const SESSIONS_FILE = path.join(process.cwd(), "sessions.json");
const AUTH_BASE_DIR = path.join(process.cwd(), ".wwebjs_auth");

function nowIso() {
  return new Date().toISOString();
}

function touch(state) {
  state.lastSeen = nowIso();
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return "";
}

function normalizeMessageBody(message) {
  return firstNonEmptyString([
    message?.body,
    message?.caption,
    message?._data?.body,
    message?._data?.caption,
    message?._data?.selectedButtonId,
    message?._data?.selectedRowId,
  ]);
}

function isSystemOrUnsupportedMessage(message) {
  const systemTypes = new Set([
    "e2e_notification",
    "notification",
    "protocol",
    "ciphertext",
    "revoked",
    "unknown",
  ]);

  const type = String(message?.type || "").toLowerCase();
  if (systemTypes.has(type)) return true;
  if (!message) return true;
  if (message.fromMe) return true;
  if (String(message.from || "").includes("@status")) return true;
  return false;
}

function bindClientEvents(sessionId, state, { onWebhook } = {}) {
  const { client } = state;

  client.on("qr", (qr) => {
    state.lastQr = qr;
    state.status = "qr";
    touch(state);
  });

  client.on("ready", () => {
    state.status = "ready";
    touch(state);
  });

  client.on("disconnected", () => {
    state.status = "disconnected";
    touch(state);
  });

  client.on("auth_failure", () => {
    state.status = "error";
    touch(state);
  });

  client.on("message", async (message) => {
    touch(state);
    if (!onWebhook) return;
    if (isSystemOrUnsupportedMessage(message)) return;

    const body = normalizeMessageBody(message);

    const basePayload = {
      event: "message",
      sessionId,
      id: message.id?._serialized,
      from: message.from,
      to: message.to,
      author: message.author,
      timestamp: message.timestamp,
      type: message.type,
      body,
      hasMedia: message.hasMedia,
    };

    try {
      if (message.hasMedia) {
        const media = await message.downloadMedia();
        await onWebhook({
          ...basePayload,
          media: {
            mimetype: media.mimetype,
            filename: media.filename || null,
            base64: media.data,
            dataUrl: `data:${media.mimetype};base64,${media.data}`,
          },
        });
      } else {
        await onWebhook(basePayload);
      }
    } catch (err) {
      await onWebhook({ ...basePayload, error: err.message });
    }
  });
}

function loadSessionIds() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return [];
    const raw = fs.readFileSync(SESSIONS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter((id) => typeof id === "string" && id.trim().length > 0);
  } catch (_) {
    return [];
  }
}

function saveSessionIds() {
  const ids = Array.from(sessions.keys());
  try {
    const next = JSON.stringify(ids, null, 2);
    if (fs.existsSync(SESSIONS_FILE)) {
      const current = fs.readFileSync(SESSIONS_FILE, "utf-8");
      if (current === next) return;
    }
    fs.writeFileSync(SESSIONS_FILE, next);
  } catch (_) {}
}

function clearStaleChromiumLocks(sessionId) {
  const sessionDir = path.join(AUTH_BASE_DIR, `session-${sessionId}`);
  const lockFiles = [
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
    "DevToolsActivePort",
  ];

  for (const file of lockFiles) {
    const filePath = path.join(sessionDir, file);
    try {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
    } catch (_) {}
  }
}

function clearSessionProfile(sessionId) {
  const sessionDir = path.join(AUTH_BASE_DIR, `session-${sessionId}`);
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch (_) {}
}

function buildClient(sessionId) {
  return new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });
}

function isProfileLockError(err) {
  const message = String(err?.message || err || "").toLowerCase();
  return (
    message.includes("profile appears to be in use") ||
    message.includes("process_singleton_posix")
  );
}

function initializeClient(sessionId, state, { onWebhook } = {}) {
  state.client.initialize().catch(async (err) => {
    if (!state.retriedAfterLock && isProfileLockError(err)) {
      state.retriedAfterLock = true;
      console.warn(
        `Session ${sessionId} locked profile detected. Resetting profile and retrying once.`,
      );

      try {
        await state.client.destroy();
      } catch (_) {}

      clearSessionProfile(sessionId);
      clearStaleChromiumLocks(sessionId);

      const retryClient = buildClient(sessionId);
      state.client = retryClient;
      state.status = "initializing";
      state.lastQr = null;
      touch(state);
      bindClientEvents(sessionId, state, { onWebhook });

      return initializeClient(sessionId, state, { onWebhook });
    }

    state.status = "error";
    touch(state);
    console.error(`Session ${sessionId} initialize error:`, err.message);
  });
}

function createSession(sessionId, { onWebhook } = {}) {
  if (!sessionId) throw new Error("sessionId is required");

  const existing = sessions.get(sessionId);
  if (existing) return existing;

  clearStaleChromiumLocks(sessionId);

  const client = buildClient(sessionId);

  const state = {
    client,
    status: "initializing",
    lastQr: null,
    createdAt: nowIso(),
    lastSeen: nowIso(),
  };

  bindClientEvents(sessionId, state, { onWebhook });
  sessions.set(sessionId, state);
  saveSessionIds();
  initializeClient(sessionId, state, { onWebhook });

  return state;
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function listSessions() {
  return Array.from(sessions.entries()).map(([sessionId, s]) => ({
    sessionId,
    status: s.status,
    createdAt: s.createdAt,
    lastSeen: s.lastSeen,
    hasQr: Boolean(s.lastQr),
  }));
}

async function removeSession(sessionId, { logout = true } = {}) {
  const s = sessions.get(sessionId);
  if (!s) return false;

  try {
    if (logout) {
      await s.client.logout();
    }
  } catch (_) {}

  try {
    await s.client.destroy();
  } catch (_) {}

  sessions.delete(sessionId);
  saveSessionIds();
  return true;
}

function initializeSessions({ onWebhook } = {}) {
  const ids = loadSessionIds();
  ids.forEach((id) => {
    try {
      createSession(id, { onWebhook });
    } catch (_) {}
  });
  return ids.length;
}

module.exports = {
  createSession,
  getSession,
  listSessions,
  removeSession,
  initializeSessions,
};
