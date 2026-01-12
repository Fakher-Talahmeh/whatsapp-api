const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");

const sessions = new Map();
const SESSIONS_FILE = path.join(process.cwd(), "sessions.json");

function nowIso() {
  return new Date().toISOString();
}

function touch(state) {
  state.lastSeen = nowIso();
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

    const basePayload = {
      event: "message",
      sessionId,
      id: message.id?._serialized,
      from: message.from,
      to: message.to,
      author: message.author,
      timestamp: message.timestamp,
      type: message.type,
      body: message.body,
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

function createSession(sessionId, { onWebhook } = {}) {
  if (!sessionId) throw new Error("sessionId is required");

  const existing = sessions.get(sessionId);
  if (existing) return existing;

  const client = new Client({
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
  client.initialize();

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
