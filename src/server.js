require("dotenv").config();
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./swagger");

const express = require("express");
const axios = require("axios");
const qrcode = require("qrcode");
const cors = require("cors");

const { MessageMedia } = require("whatsapp-web.js");
const sessionManager = require("./sessionManager");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" })); // لتلقي base64/صور كبيرة
app.use(express.urlencoded({ extended: true }));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
/**
 * @openapi
 * /openapi.json:
 *   get:
 *     summary: Get OpenAPI specification JSON
 *     security: []
 *     responses:
 *       200:
 *         description: OpenAPI document
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/OpenApiSpecResponse"
 */
app.get("/openapi.json", (req, res) => res.json(swaggerSpec));

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const API_KEY = process.env.API_KEY || "";

const QR_RATE_WINDOW_MS = 60_000;
const QR_RATE_MAX = 30;
const qrRate = new Map();

/** حماية بسيطة للـ API */
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!API_KEY) return res.status(500).json({ error: "API_KEY not set" });
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

/** إرسال حدث إلى webhook خارجي */
async function sendToWebhook(payload) {
  if (!WEBHOOK_URL) return;
  try {
    await axios.post(WEBHOOK_URL, payload, {
      timeout: 10_000,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
}

function getClientForSession(sessionId) {
  if (!sessionId) {
    return { error: { status: 400, message: "sessionId required" } };
  }

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return { error: { status: 404, message: "Session not found" } };
  }

  if (session.status !== "ready") {
    return { error: { status: 503, message: "Session not ready" } };
  }

  return { client: session.client };
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

async function collectUnreadMessages(client) {
  const chats = await client.getChats();
  const unreadMessages = [];

  for (const chat of chats) {
    if (!chat.unreadCount || chat.unreadCount <= 0) continue;

    const msgs = await chat.fetchMessages({ limit: chat.unreadCount });
    for (const msg of msgs) {
      if (isSystemOrUnsupportedMessage(msg)) continue;

      unreadMessages.push({
        id: msg.id?._serialized || null,
        from: msg.from,
        body: normalizeMessageBody(msg),
        timestamp: msg.timestamp,
        chatId: msg.from || chat.id?._serialized || null,
      });
    }
  }

  return unreadMessages;
}

async function createImageMedia(image) {
  if (!image || typeof image !== "object") {
    throw new Error("Each image must be an object");
  }

  if (image.imageUrl) {
    return MessageMedia.fromUrl(image.imageUrl, { unsafeMime: true });
  }

  if (image.mimetype && image.base64) {
    return new MessageMedia(
      image.mimetype,
      image.base64,
      image.filename || "image",
    );
  }

  throw new Error(
    "Each image must include either imageUrl or mimetype with base64",
  );
}

async function ensurePairingCodeHandler(client) {
  if (!client?.pupPage) {
    throw new Error("Session browser is not ready yet");
  }

  await client.pupPage.evaluate(() => {
    if (typeof window.onCodeReceivedEvent !== "function") {
      // whatsapp-web.js expects this callback when requesting pairing code.
      window.onCodeReceivedEvent = (code) => code;
    }
  });
}

function checkQrRateLimit(req, res, next) {
  // Simple in-memory limiter; replace with a shared store in production.
  const key = `${req.ip}:${req.params.sessionId}`;
  const now = Date.now();
  const entry = qrRate.get(key);

  if (!entry || now - entry.start > QR_RATE_WINDOW_MS) {
    qrRate.set(key, { start: now, count: 1 });
    return next();
  }

  if (entry.count >= QR_RATE_MAX) {
    return res.status(429).json({ error: "Too many requests" });
  }

  entry.count += 1;
  return next();
}

sessionManager.initializeSessions({ onWebhook: sendToWebhook });

/** Health */
/**
 * @openapi
 * /health:
 *   get:
 *     summary: Health check
 *     security: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/HealthResponse"
 */
app.get("/health", (req, res) => {
  const sessions = sessionManager.listSessions();
  const readyCount = sessions.filter((s) => s.status === "ready").length;
  res.json({ ok: true, sessions: sessions.length, readyCount });
});

/**
 * @openapi
 * /sessions:
 *   post:
 *     summary: Create or initialize a WhatsApp session
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: "#/components/schemas/CreateSessionRequest"
 *     responses:
 *       200:
 *         description: Session created or returned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/SessionInfo"
 *       400:
 *         description: sessionId required
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
app.post("/sessions", requireApiKey, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId required" });
    }

    const session = sessionManager.createSession(sessionId, {
      onWebhook: sendToWebhook,
    });

    res.json({
      sessionId,
      status: session.status,
      createdAt: session.createdAt,
      lastSeen: session.lastSeen,
      hasQr: Boolean(session.lastQr),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @openapi
 * /sessions:
 *   get:
 *     summary: List WhatsApp sessions
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Session list
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/SessionListResponse"
 *       401:
 *         description: Unauthorized
 */
app.get("/sessions", requireApiKey, (req, res) => {
  res.json({ sessions: sessionManager.listSessions() });
});

/**
 * @openapi
 * /unread-messages:
 *   get:
 *     summary: Get unread messages across all sessions and chats
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Unread messages
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/UnreadMessagesResponse"
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
app.get("/unread-messages", requireApiKey, async (req, res) => {
  try {
    const sessions = sessionManager.listSessions();
    const results = [];

    for (const s of sessions) {
      const session = sessionManager.getSession(s.sessionId);
      if (!session || s.status !== "ready") {
        results.push({
          sessionId: s.sessionId,
          status: s.status,
          messages: [],
        });
        continue;
      }

      const unreadMessages = await collectUnreadMessages(session.client);

      results.push({
        sessionId: s.sessionId,
        status: s.status,
        messages: unreadMessages,
      });
    }

    res.json({ sessions: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @openapi
 * /sessions/{sessionId}/unread-messages:
 *   get:
 *     summary: Get unread messages for a specific session
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Unread messages
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/UnreadSessionMessages"
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Session not found
 *       503:
 *         description: Session not ready
 *       500:
 *         description: Server error
 */
app.get(
  "/sessions/:sessionId/unread-messages",
  requireApiKey,
  async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      if (session.status !== "ready") {
        return res.status(503).json({ error: "Session not ready" });
      }

      const unreadMessages = await collectUnreadMessages(session.client);

      res.json({
        sessionId,
        status: session.status,
        messages: unreadMessages,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

/**
 * @openapi
 * /sessions/{sessionId}/qr:
 *   get:
 *     summary: Get latest QR for a session
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: QR retrieved
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/SessionQrResponse"
 *       404:
 *         description: Session or QR not found
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many requests
 *       500:
 *         description: Server error
 */
app.get(
  "/sessions/:sessionId/qr",
  requireApiKey,
  checkQrRateLimit,
  async (req, res) => {
    const session = sessionManager.getSession(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (!session.lastQr) {
      return res.status(404).json({ error: "QR not available" });
    }

    let qrBase64 = null;
    try {
      qrBase64 = await qrcode.toDataURL(session.lastQr);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    res.json({
      sessionId: req.params.sessionId,
      status: session.status,
      qr: session.lastQr,
      qrBase64,
    });
  },
);

/**
 * @openapi
 * /sessions/{sessionId}:
 *   delete:
 *     summary: Destroy a WhatsApp session and remove auth data
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Session removed
 *       404:
 *         description: Session not found
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
app.delete("/sessions/:sessionId", requireApiKey, async (req, res) => {
  try {
    const removed = await sessionManager.removeSession(req.params.sessionId, {
      logout: true,
    });

    if (!removed) {
      return res.status(404).json({ error: "Session not found" });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** إرسال رسالة نصية */
/**
 * @openapi
 * /send-text:
 *   post:
 *     summary: Send a WhatsApp text message
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: "#/components/schemas/SendTextRequest"
 *     responses:
 *       200:
 *         description: Sent
 *       401:
 *         description: Unauthorized
 *       400:
 *         description: Invalid request
 *       503:
 *         description: Session not ready
 *       404:
 *         description: Session not found
 *       500:
 *         description: Server error
 */

/**
 * @openapi
 * /sessions/{sessionId}/pairing-code:
 *   post:
 *     summary: Generate WhatsApp pairing code by phone number (without QR scan)
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: "#/components/schemas/PairingCodeRequest"
 *     responses:
 *       200:
 *         description: Pairing code generated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/PairingCodeResponse"
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Session not found
 *       500:
 *         description: Server error
 */
app.post(
  "/sessions/:sessionId/pairing-code",
  requireApiKey,
  async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { phoneNumber, showNotification = true, intervalMs = 180000 } =
        req.body;

      if (!phoneNumber) {
        return res.status(400).json({ error: "phoneNumber required" });
      }

      if (!/^\d{6,20}$/.test(phoneNumber)) {
        return res.status(400).json({
          error: "phoneNumber must be digits only in international format",
        });
      }

      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      await ensurePairingCodeHandler(session.client);

      const pairingCode = await session.client.requestPairingCode(
        phoneNumber,
        Boolean(showNotification),
        Number(intervalMs),
      );

      res.json({
        ok: true,
        sessionId,
        status: session.status,
        pairingCode,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

app.post("/send-text", requireApiKey, async (req, res) => {
  try {
    const { sessionId, to, text } = req.body;
    if (!sessionId || !to || !text) {
      return res.status(400).json({ error: "sessionId, to and text required" });
    }

    const { client, error } = getClientForSession(sessionId);
    if (error) return res.status(error.status).json({ error: error.message });

    // to مثال: "9705xxxxxxx@c.us"
    const msg = await client.sendMessage(to, text);
    res.json({ ok: true, messageId: msg.id?._serialized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** إرسال صورة من رابط */
/**
 * @openapi
 * /send-image-url:
 *   post:
 *     summary: Send an image to WhatsApp using a public URL
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: "#/components/schemas/SendImageUrlRequest"
 *     responses:
 *       200:
 *         description: Sent
 *       401:
 *         description: Unauthorized
 *       400:
 *         description: Invalid request
 *       503:
 *         description: Session not ready
 *       404:
 *         description: Session not found
 *       500:
 *         description: Server error
 */

app.post("/send-image-url", requireApiKey, async (req, res) => {
  try {
    const { sessionId, to, imageUrl, caption } = req.body;
    if (!sessionId || !to || !imageUrl) {
      return res
        .status(400)
        .json({ error: "sessionId, to and imageUrl required" });
    }

    const { client, error } = getClientForSession(sessionId);
    if (error) return res.status(error.status).json({ error: error.message });

    const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
    const msg = await client.sendMessage(to, media, { caption: caption || "" });

    res.json({ ok: true, messageId: msg.id?._serialized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** إرسال صورة من Base64 (عندك في النظام) */
/**
 * @openapi
 * /send-image-base64:
 *   post:
 *     summary: Send an image to WhatsApp using base64 data
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: "#/components/schemas/SendImageBase64Request"
 *     responses:
 *       200:
 *         description: Sent
 *       401:
 *         description: Unauthorized
 *       400:
 *         description: Invalid request
 *       503:
 *         description: Session not ready
 *       404:
 *         description: Session not found
 *       500:
 *         description: Server error
 */

app.post("/send-image-base64", requireApiKey, async (req, res) => {
  try {
    const { sessionId, to, mimetype, base64, filename, caption } = req.body;
    if (!sessionId || !to || !mimetype || !base64) {
      return res
        .status(400)
        .json({ error: "sessionId, to, mimetype, base64 required" });
    }

    const { client, error } = getClientForSession(sessionId);
    if (error) return res.status(error.status).json({ error: error.message });

    const media = new MessageMedia(mimetype, base64, filename || "image");
    const msg = await client.sendMessage(to, media, { caption: caption || "" });

    res.json({ ok: true, messageId: msg.id?._serialized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** (اختياري) استخراج base64 لفويس/ميديا عبر Message ID */
/**
 * @openapi
 * /send-images-batch:
 *   post:
 *     summary: Send multiple WhatsApp images in a single API request
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: "#/components/schemas/SendImagesBatchRequest"
 *     responses:
 *       200:
 *         description: Sent
 *       401:
 *         description: Unauthorized
 *       400:
 *         description: Invalid request
 *       503:
 *         description: Session not ready
 *       404:
 *         description: Session not found
 *       500:
 *         description: Server error
 */
app.post("/send-images-batch", requireApiKey, async (req, res) => {
  try {
    const { sessionId, to, caption, images } = req.body;
    if (!sessionId || !to || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({
        error: "sessionId, to and a non-empty images array are required",
      });
    }

    const { client, error } = getClientForSession(sessionId);
    if (error) return res.status(error.status).json({ error: error.message });

    const messages = [];

    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const media = await createImageMedia(image);
      const msg = await client.sendMessage(to, media, {
        caption:
          image.caption !== undefined
            ? String(image.caption)
            : index === 0
              ? caption || ""
              : "",
      });

      messages.push({
        index,
        messageId: msg.id?._serialized || null,
      });
    }

    res.json({
      ok: true,
      sent: messages.length,
      messages,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @openapi
 * /send-file-base64:
 *   post:
 *     summary: Send a file/document to WhatsApp using base64 data
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: "#/components/schemas/SendFileBase64Request"
 *     responses:
 *       200:
 *         description: Sent
 *       401:
 *         description: Unauthorized
 *       400:
 *         description: Invalid request
 *       503:
 *         description: Session not ready
 *       404:
 *         description: Session not found
 *       500:
 *         description: Server error
 */
app.post("/send-file-base64", requireApiKey, async (req, res) => {
  try {
    const { sessionId, to, mimetype, base64, filename, caption } = req.body;
    if (!sessionId || !to || !mimetype || !base64 || !filename) {
      return res.status(400).json({
        error: "sessionId, to, mimetype, base64 and filename required",
      });
    }

    const { client, error } = getClientForSession(sessionId);
    if (error) return res.status(error.status).json({ error: error.message });

    const media = new MessageMedia(mimetype, base64, filename);
    const msg = await client.sendMessage(to, media, {
      caption: caption || "",
      sendMediaAsDocument: true,
    });

    res.json({ ok: true, messageId: msg.id?._serialized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
/**
 * @openapi
 * /fetch-media:
 *   post:
 *     summary: Fetch media (base64) from a recent message by chatId + messageId
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: "#/components/schemas/FetchMediaRequest"
 *     responses:
 *       200:
 *         description: Media returned
 *       401:
 *         description: Unauthorized
 *       400:
 *         description: Invalid request
 *       404:
 *         description: Session or message not found
 *       503:
 *         description: Session not ready
 *       500:
 *         description: Server error
 */

app.post("/fetch-media", requireApiKey, async (req, res) => {
  try {
    const { sessionId, chatId, messageId } = req.body;
    if (!sessionId || !chatId || !messageId) {
      return res
        .status(400)
        .json({ error: "sessionId, chatId and messageId required" });
    }

    const { client, error } = getClientForSession(sessionId);
    if (error) return res.status(error.status).json({ error: error.message });

    const chat = await client.getChatById(chatId);
    const msgs = await chat.fetchMessages({ limit: 50 });

    const target = msgs.find((m) => m.id?._serialized === messageId);
    if (!target)
      return res
        .status(404)
        .json({ error: "Message not found in last 50 messages" });

    if (!target.hasMedia)
      return res.status(400).json({ error: "Message has no media" });

    const media = await target.downloadMedia();
    res.json({
      ok: true,
      mimetype: media.mimetype,
      filename: media.filename || null,
      base64: media.data,
      dataUrl: `data:${media.mimetype};base64,${media.data}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));



