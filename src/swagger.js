const swaggerJSDoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "WhatsApp Backend API",
      version: "1.0.0",
      description:
        "API for sending/receiving WhatsApp messages via whatsapp-web.js",
    },
    // servers: [{ url: "http://localhost:3000" }],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
        },
      },
      schemas: {
        CreateSessionRequest: {
          type: "object",
          required: ["sessionId"],
          properties: {
            sessionId: { type: "string", example: "session-1" },
          },
        },
        SessionInfo: {
          type: "object",
          properties: {
            sessionId: { type: "string", example: "session-1" },
            status: {
              type: "string",
              enum: ["initializing", "qr", "ready", "disconnected", "error"],
            },
            createdAt: { type: "string", example: "2025-01-12T12:00:00.000Z" },
            lastSeen: { type: "string", example: "2025-01-12T12:01:00.000Z" },
            hasQr: { type: "boolean", example: true },
          },
        },
        SessionListResponse: {
          type: "object",
          properties: {
            sessions: {
              type: "array",
              items: { $ref: "#/components/schemas/SessionInfo" },
            },
          },
        },
        UnreadMessageItem: {
          type: "object",
          properties: {
            id: { type: "string", example: "false_9705..._ABCDEF" },
            from: { type: "string", example: "9705XXXXXXX@c.us" },
            body: { type: "string", example: "Hello" },
            timestamp: { type: "number", example: 1700000000 },
            chatId: { type: "string", example: "9705XXXXXXX@c.us" },
          },
        },
        UnreadSessionMessages: {
          type: "object",
          properties: {
            sessionId: { type: "string", example: "session-1" },
            status: {
              type: "string",
              enum: ["initializing", "qr", "ready", "disconnected", "error"],
            },
            messages: {
              type: "array",
              items: { $ref: "#/components/schemas/UnreadMessageItem" },
            },
          },
        },
        UnreadMessagesResponse: {
          type: "object",
          properties: {
            sessions: {
              type: "array",
              items: { $ref: "#/components/schemas/UnreadSessionMessages" },
            },
          },
        },
        SessionQrResponse: {
          type: "object",
          properties: {
            sessionId: { type: "string", example: "session-1" },
            status: {
              type: "string",
              enum: ["initializing", "qr", "ready", "disconnected", "error"],
            },
            qr: { type: "string", example: "qr-string" },
            qrBase64: {
              type: "string",
              example: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
            },
          },
        },
        SendTextRequest: {
          type: "object",
          required: ["sessionId", "to", "text"],
          properties: {
            sessionId: { type: "string", example: "session-1" },
            to: { type: "string", example: "9705XXXXXXX@c.us" },
            text: { type: "string", example: "Hello" },
          },
        },
        SendImageUrlRequest: {
          type: "object",
          required: ["sessionId", "to", "imageUrl"],
          properties: {
            sessionId: { type: "string", example: "session-1" },
            to: { type: "string", example: "9705XXXXXXX@c.us" },
            imageUrl: {
              type: "string",
              example: "https://example.com/image.jpg",
            },
            caption: { type: "string", example: "Photo" },
          },
        },
        SendImageBase64Request: {
          type: "object",
          required: ["sessionId", "to", "mimetype", "base64"],
          properties: {
            sessionId: { type: "string", example: "session-1" },
            to: { type: "string", example: "9705XXXXXXX@c.us" },
            mimetype: { type: "string", example: "image/jpeg" },
            base64: { type: "string", description: "Base64 data without prefix" },
            filename: { type: "string", example: "photo.jpg" },
            caption: { type: "string", example: "Photo" },
          },
        },
        FetchMediaRequest: {
          type: "object",
          required: ["sessionId", "chatId", "messageId"],
          properties: {
            sessionId: { type: "string", example: "session-1" },
            chatId: { type: "string", example: "9705XXXXXXX@c.us" },
            messageId: { type: "string", example: "false_9705..._ABCDEF" },
          },
        },
        HealthResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean", example: true },
            sessions: { type: "number", example: 2 },
            readyCount: { type: "number", example: 1 },
          },
        },
      },
    },
    security: [{ ApiKeyAuth: [] }],
  },
  apis: ["./src/server.js"], // سنضع التعليقات هنا
};

module.exports = swaggerJSDoc(options);
