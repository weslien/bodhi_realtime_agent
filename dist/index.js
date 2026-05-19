import {
  AUDIO_FORMAT,
  AgentError,
  AgentRouter,
  AudioBuffer,
  BackgroundNotificationQueue,
  CancelledError,
  ClientSenderAdapter,
  ConversationContext,
  ConversationHistoryWriter,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_EXTRACTION_TIMEOUT_MS,
  DEFAULT_RECONNECT_TIMEOUT_MS,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  DirectiveManager,
  EventBus,
  FrameworkError,
  GeminiLiveTransport,
  HooksManager,
  InputTimeoutError,
  InteractionModeManager,
  MemoryCacheManager,
  MemoryDistiller,
  MemoryError,
  SessionCompletedError,
  SessionError,
  SessionManager,
  SubagentSessionImpl,
  ToolCallRouter,
  ToolExecutionError,
  ToolExecutor,
  TranscriptManager,
  TransportError,
  ValidationError,
  VoiceSession,
  createAgentContext,
  createAskUserTool,
  normalizeOpenAIResponseUsage,
  normalizeOpenAITranscriptionUsage,
  runSubagent,
  zodToJsonSchema
} from "./chunk-WIPPBHMV.js";

// src/core/session-store.ts
var InMemorySessionStore = class {
  store = /* @__PURE__ */ new Map();
  async save(checkpoint) {
    this.store.set(checkpoint.sessionId, structuredClone(checkpoint));
  }
  async load(sessionId) {
    const checkpoint = this.store.get(sessionId);
    return checkpoint ? structuredClone(checkpoint) : null;
  }
  async delete(sessionId) {
    this.store.delete(sessionId);
  }
};

// src/core/multi-user-session-manager.ts
var MultiUserSessionManager = class {
  sessions = /* @__PURE__ */ new Map();
  sessionMetadata = /* @__PURE__ */ new Map();
  cleanupTimer = null;
  config;
  constructor(config = {}) {
    this.config = {
      maxSessionsPerUser: config.maxSessionsPerUser ?? 5,
      maxTotalSessions: config.maxTotalSessions ?? 1e3,
      sessionTimeoutMs: config.sessionTimeoutMs ?? 30 * 60 * 1e3,
      // 30 minutes
      cleanupIntervalMs: config.cleanupIntervalMs ?? 60 * 1e3
      // 1 minute
    };
    this.startCleanupTimer();
  }
  /**
   * Create a new VoiceSession for a user.
   */
  async createSession(userId, sessionConfig, webSocketId) {
    if (this.sessions.size >= this.config.maxTotalSessions) {
      throw new Error(`Maximum total sessions (${this.config.maxTotalSessions}) reached`);
    }
    const userSessions = this.getAllSessionsForUser(userId);
    if (userSessions.length >= this.config.maxSessionsPerUser) {
      throw new Error(
        `Maximum sessions per user (${this.config.maxSessionsPerUser}) reached for user ${userId}`
      );
    }
    const sessionId = this.generateSessionId(userId);
    const { VoiceSession: VoiceSession2 } = await import("./voice-session-W5EFINCE.js");
    const session = new VoiceSession2({
      ...sessionConfig,
      sessionId,
      userId
    });
    this.sessions.set(sessionId, session);
    this.sessionMetadata.set(sessionId, {
      sessionId,
      userId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      webSocketId
    });
    return session;
  }
  /**
   * Get a session by ID.
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId) ?? null;
  }
  /**
   * Get session metadata.
   */
  getSessionMetadata(sessionId) {
    return this.sessionMetadata.get(sessionId) ?? null;
  }
  /**
   * Get all active sessions for a user.
   */
  getAllSessionsForUser(userId) {
    const sessions = [];
    for (const [sessionId, metadata] of this.sessionMetadata.entries()) {
      if (metadata.userId === userId) {
        const session = this.sessions.get(sessionId);
        if (session) {
          sessions.push(session);
        }
      }
    }
    return sessions;
  }
  /**
   * Update last activity time for a session.
   */
  updateActivity(sessionId) {
    const metadata = this.sessionMetadata.get(sessionId);
    if (metadata) {
      metadata.lastActivityAt = Date.now();
    }
  }
  /**
   * Close and remove a session.
   */
  async closeSession(sessionId, reason = "user_disconnect") {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        await session.close(reason);
      } catch (error) {
        console.error(`Error closing session ${sessionId}:`, error);
      }
    }
    this.sessions.delete(sessionId);
    this.sessionMetadata.delete(sessionId);
  }
  /**
   * Close all sessions for a user.
   */
  async closeAllSessionsForUser(userId, reason = "user_logout") {
    const sessions = this.getAllSessionsForUser(userId);
    await Promise.all(sessions.map((s) => this.closeSession(s.getSessionId(), reason)));
  }
  /**
   * Get statistics about active sessions.
   */
  getStats() {
    const sessionsByUser = {};
    let oldestSession = null;
    let newestSession = null;
    for (const metadata of this.sessionMetadata.values()) {
      sessionsByUser[metadata.userId] = (sessionsByUser[metadata.userId] ?? 0) + 1;
      if (oldestSession === null || metadata.createdAt < oldestSession) {
        oldestSession = metadata.createdAt;
      }
      if (newestSession === null || metadata.createdAt > newestSession) {
        newestSession = metadata.createdAt;
      }
    }
    return {
      totalSessions: this.sessions.size,
      sessionsByUser,
      oldestSession,
      newestSession
    };
  }
  /**
   * Get all session metadata for API.
   */
  getAllSessionMetadata() {
    return Array.from(this.sessionMetadata.values());
  }
  /**
   * Cleanup idle sessions.
   */
  async cleanupIdleSessions() {
    const now = Date.now();
    const idleSessions = [];
    for (const [sessionId, metadata] of this.sessionMetadata.entries()) {
      const idleTime = now - metadata.lastActivityAt;
      if (idleTime > this.config.sessionTimeoutMs) {
        idleSessions.push(sessionId);
      }
    }
    await Promise.all(
      idleSessions.map((sessionId) => this.closeSession(sessionId, "idle_timeout"))
    );
    return idleSessions.length;
  }
  /**
   * Start the cleanup timer.
   */
  startCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanupTimer = setInterval(async () => {
      try {
        const cleaned = await this.cleanupIdleSessions();
        if (cleaned > 0) {
          console.log(`[MultiUserSessionManager] Cleaned up ${cleaned} idle sessions`);
        }
      } catch (error) {
        console.error("[MultiUserSessionManager] Cleanup error:", error);
      }
    }, this.config.cleanupIntervalMs);
  }
  /**
   * Stop the cleanup timer and close all sessions.
   */
  async shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map((id) => this.closeSession(id, "server_shutdown")));
  }
  /**
   * Generate a unique session ID.
   */
  generateSessionId(userId) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9);
    return `session_${userId}_${timestamp}_${random}`;
  }
};

// src/config/server-config.ts
function normalizePhoneMapKey(phone) {
  return phone.replace(/[^0-9]/g, "");
}
function parseTwilioNumberAgentProfiles(raw) {
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `TWILIO_NUMBER_AGENT_PROFILES must be valid JSON object: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TWILIO_NUMBER_AGENT_PROFILES must be a JSON object of number->profile");
  }
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    const phoneKey = normalizePhoneMapKey(key);
    if (!phoneKey) {
      throw new Error(`TWILIO_NUMBER_AGENT_PROFILES has invalid phone key: "${key}"`);
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`TWILIO_NUMBER_AGENT_PROFILES value for "${key}" must be a non-empty string`);
    }
    out[phoneKey] = value.trim().slice(0, 64);
  }
  return out;
}
function loadConfig() {
  const port = Number(process.env.PORT) || 9900;
  const host = process.env.HOST || "0.0.0.0";
  const llmProvider = process.env.LLM_PROVIDER === "openai" ? "openai" : "gemini";
  const apiKey = process.env.GEMINI_API_KEY || "";
  const openaiApiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }
  if (llmProvider === "openai" && !openaiApiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required when LLM_PROVIDER=openai");
  }
  const authEnabled = process.env.AUTH_ENABLED === "true";
  const authMethod = process.env.AUTH_METHOD || "anonymous";
  const config = {
    port,
    host,
    llmProvider,
    apiKey,
    /** Keep when set so per-profile OpenAI sessions work while global default stays Gemini. */
    openaiApiKey: openaiApiKey.trim() ? openaiApiKey : void 0,
    maxSessionsPerUser: Number(process.env.MAX_SESSIONS_PER_USER) || 5,
    maxTotalSessions: Number(process.env.MAX_TOTAL_SESSIONS) || 1e3,
    sessionTimeoutMs: Number(process.env.SESSION_TIMEOUT_MS) || 30 * 60 * 1e3,
    // 30 minutes
    cleanupIntervalMs: Number(process.env.CLEANUP_INTERVAL_MS) || 60 * 1e3,
    // 1 minute
    auth: {
      enabled: authEnabled,
      method: authMethod,
      apiKey: process.env.AUTH_API_KEY,
      jwtSecret: process.env.JWT_SECRET,
      supabase: process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY ? {
        url: process.env.SUPABASE_URL,
        anonKey: process.env.SUPABASE_ANON_KEY,
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
      } : void 0,
      oauth: process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET ? {
        clientId: process.env.OAUTH_CLIENT_ID,
        clientSecret: process.env.OAUTH_CLIENT_SECRET,
        tokenEndpoint: process.env.OAUTH_TOKEN_ENDPOINT || ""
      } : void 0
    },
    rateLimiting: {
      enabled: process.env.RATE_LIMITING_ENABLED !== "false",
      requestsPerMinute: Number(process.env.RATE_LIMIT_REQUESTS_PER_MIN) || 60,
      connectionsPerMinute: Number(process.env.RATE_LIMIT_CONNECTIONS_PER_MIN) || 10
    },
    logging: {
      level: process.env.LOG_LEVEL || "info",
      format: process.env.LOG_FORMAT || "text"
    },
    twilio: process.env.TWILIO_INBOUND_ENABLED === "true" && process.env.TWILIO_WEBHOOK_URL ? {
      inboundEnabled: true,
      webhookUrl: process.env.TWILIO_WEBHOOK_URL,
      defaultAgentProfile: process.env.TWILIO_DEFAULT_AGENT_PROFILE?.trim().slice(0, 64) || "standard",
      numberAgentProfiles: parseTwilioNumberAgentProfiles(
        process.env.TWILIO_NUMBER_AGENT_PROFILES || ""
      )
    } : void 0
  };
  if (config.auth.enabled) {
    if (config.auth.method === "api_key" && !config.auth.apiKey) {
      throw new Error("AUTH_API_KEY required when AUTH_METHOD=api_key");
    }
    if (config.auth.method === "jwt" && !config.auth.jwtSecret) {
      throw new Error("JWT_SECRET required when AUTH_METHOD=jwt");
    }
    if (config.auth.method === "oauth" && !config.auth.oauth) {
      throw new Error("OAuth config required when AUTH_METHOD=oauth");
    }
    if (config.auth.method === "supabase" && !config.auth.supabase) {
      throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY required when AUTH_METHOD=supabase");
    }
  }
  return config;
}
function validateConfig(config) {
  if (config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid port: ${config.port}`);
  }
  if (config.maxSessionsPerUser < 1) {
    throw new Error("MAX_SESSIONS_PER_USER must be at least 1");
  }
  if (config.maxTotalSessions < 1) {
    throw new Error("MAX_TOTAL_SESSIONS must be at least 1");
  }
  if (config.sessionTimeoutMs < 0) {
    throw new Error("SESSION_TIMEOUT_MS must be non-negative");
  }
  if (config.cleanupIntervalMs < 1e3) {
    throw new Error("CLEANUP_INTERVAL_MS must be at least 1000ms");
  }
}

// src/memory/json-memory-store.ts
import { mkdir, readFile } from "fs/promises";
import { dirname, join } from "path";
import writeFileAtomic from "write-file-atomic";
var EMPTY_FILE = { directives: {}, facts: [] };
var JsonMemoryStore = class {
  constructor(baseDir) {
    this.baseDir = baseDir;
  }
  baseDir;
  async addFacts(userId, facts) {
    if (facts.length === 0) return;
    const filePath = this.filePath(userId);
    const file = await this.readFile(filePath);
    for (const fact of facts) {
      file.facts.push({ content: fact.content, category: fact.category });
    }
    await this.writeFile(filePath, file);
  }
  async getAll(userId) {
    const file = await this.readFile(this.filePath(userId));
    return file.facts.map((f) => ({
      content: f.content,
      category: f.category,
      timestamp: 0
    }));
  }
  async replaceAll(userId, facts) {
    const filePath = this.filePath(userId);
    const file = await this.readFile(filePath);
    file.facts = facts.map((f) => ({ content: f.content, category: f.category }));
    await this.writeFile(filePath, file);
  }
  async getDirectives(userId) {
    const file = await this.readFile(this.filePath(userId));
    return { ...file.directives };
  }
  async setDirectives(userId, directives) {
    const filePath = this.filePath(userId);
    const file = await this.readFile(filePath);
    file.directives = { ...directives };
    await this.writeFile(filePath, file);
  }
  filePath(userId) {
    return join(this.baseDir, `${userId}.json`);
  }
  async readFile(filePath) {
    try {
      const raw = await readFile(filePath, "utf-8");
      if (!raw.trim()) return { ...EMPTY_FILE, directives: {}, facts: [] };
      const parsed = JSON.parse(raw);
      return {
        directives: parsed.directives && typeof parsed.directives === "object" ? { ...parsed.directives } : {},
        facts: Array.isArray(parsed.facts) ? [...parsed.facts] : []
      };
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code !== "ENOENT") {
        console.warn(`[JsonMemoryStore] Error reading ${filePath}: ${err.message}`);
      }
      return { ...EMPTY_FILE, directives: {}, facts: [] };
    }
  }
  async writeFile(filePath, file) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, JSON.stringify(file, null, 2));
  }
};

// src/telephony/audio-codec.ts
var MULAW_BIAS = 132;
var MULAW_CLIP = 32635;
function mulawDecode(mulaw) {
  const mu = ~mulaw & 255;
  const sign = mu & 128;
  const exponent = mu >> 4 & 7;
  const mantissa = mu & 15;
  let sample = (mantissa << 3) + MULAW_BIAS << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}
function mulawEncode(sample) {
  const sign = sample < 0 ? 128 : 0;
  let magnitude = sample < 0 ? -sample : sample;
  if (magnitude > MULAW_CLIP) magnitude = MULAW_CLIP;
  magnitude += MULAW_BIAS;
  const exponent = Math.floor(Math.log2(magnitude)) - 7;
  const exp = Math.max(0, Math.min(7, exponent));
  const mantissa = magnitude >> exp + 3 & 15;
  return ~(sign | exp << 4 | mantissa) & 255;
}
function decodeMulawToPcm(mulawBuf) {
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    const sample = mulawDecode(mulawBuf[i]);
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}
function encodePcmToMulaw(pcmBuf) {
  const mulaw = Buffer.alloc(pcmBuf.length / 2);
  for (let i = 0; i < mulaw.length; i++) {
    const sample = pcmBuf.readInt16LE(i * 2);
    mulaw[i] = mulawEncode(sample);
  }
  return mulaw;
}
function resample(pcmBuf, fromRate, toRate) {
  if (fromRate === toRate) return pcmBuf;
  const inputSamples = pcmBuf.length / 2;
  const ratio = fromRate / toRate;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;
    const s0 = pcmBuf.readInt16LE(Math.min(srcIndex, inputSamples - 1) * 2);
    const s1 = pcmBuf.readInt16LE(Math.min(srcIndex + 1, inputSamples - 1) * 2);
    const interpolated = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
  }
  return output;
}
function twilioToFramework(mulawBase64) {
  const mulawBuf = Buffer.from(mulawBase64, "base64");
  const pcm8k = decodeMulawToPcm(mulawBuf);
  return resample(pcm8k, 8e3, 16e3);
}
function frameworkToTwilio(pcmInput, inputRate = 16e3) {
  const pcm = typeof pcmInput === "string" ? Buffer.from(pcmInput, "base64") : pcmInput;
  const pcm8k = resample(pcm, inputRate, 8e3);
  const mulaw = encodePcmToMulaw(pcm8k);
  return mulaw.toString("base64");
}

// src/telephony/twilio-bridge.ts
import { randomBytes } from "crypto";
import twilio from "twilio";

// src/telephony/twilio-webhook-server.ts
import { createServer } from "http";
import { WebSocketServer } from "ws";
var TwilioWebhookServer = class {
  constructor(config) {
    this.config = config;
  }
  config;
  httpServer = null;
  wss = null;
  activeWs = null;
  /** Start the HTTP + WebSocket server. */
  async start() {
    if (this.httpServer) return;
    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer, path: "/twilio/media" });
    this.wss.on("connection", (ws, req) => this.handleWsConnection(ws, req));
    return new Promise((resolve) => {
      this.httpServer?.listen(this.config.port, () => resolve());
    });
  }
  /** Stop the server and close all connections. */
  async stop() {
    if (this.activeWs) {
      this.activeWs.close();
      this.activeWs = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer?.close(() => {
          this.httpServer = null;
          resolve();
        });
      });
    }
  }
  /** Send mulaw audio to Twilio via the active Media Stream. */
  sendMedia(mulawBase64, streamSid) {
    if (!this.activeWs || this.activeWs.readyState !== 1) return;
    const message = JSON.stringify({
      event: "media",
      streamSid: streamSid ?? "",
      media: {
        payload: mulawBase64
      }
    });
    this.activeWs.send(message);
  }
  // -----------------------------------------------------------------------
  // HTTP handler
  // -----------------------------------------------------------------------
  handleHttp(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/twilio/voice") {
      this.handleVoiceWebhook(url, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/twilio/status") {
      this.handleStatusCallback(req, res);
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
  }
  handleVoiceWebhook(url, res) {
    const authParam = url.searchParams.get("auth");
    const wsUrl = `${this.config.port ? "wss" : "ws"}://${url.host}/twilio/media`;
    const twiml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Response>",
      "  <Connect>",
      `    <Stream url="${wsUrl}">`,
      `      <Parameter name="auth" value="${authParam ?? ""}" />`,
      "    </Stream>",
      "  </Connect>",
      "</Response>"
    ].join("\n");
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml);
  }
  handleStatusCallback(req, res) {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const callSid = params.get("CallSid") ?? "";
      const callStatus = params.get("CallStatus") ?? "";
      const answeredBy = params.get("AnsweredBy") ?? void 0;
      this.config.onStatusCallback?.(callSid, callStatus, answeredBy);
      res.writeHead(200);
      res.end();
    });
  }
  // -----------------------------------------------------------------------
  // WebSocket handler (Twilio Media Streams)
  // -----------------------------------------------------------------------
  handleWsConnection(ws, _req) {
    let authenticated = false;
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleWsMessage(ws, msg, authenticated, (auth) => {
          authenticated = auth;
        });
      } catch {
      }
    });
    ws.on("close", () => {
      if (ws === this.activeWs) {
        this.activeWs = null;
        this.config.onStreamStopped();
      }
    });
  }
  handleWsMessage(ws, msg, authenticated, setAuth) {
    switch (msg.event) {
      case "connected":
        break;
      case "start": {
        const startMsg = msg.start;
        const customParams = startMsg?.customParameters;
        const authToken = customParams?.auth;
        if (authToken !== this.config.wsAuthToken) {
          ws.close(4001, "Unauthorized");
          return;
        }
        setAuth(true);
        this.activeWs = ws;
        const streamSid = startMsg?.streamSid ?? "";
        const callSid = startMsg?.callSid ?? "";
        this.config.onStreamStarted(streamSid, callSid);
        break;
      }
      case "media": {
        if (!authenticated) return;
        const media = msg.media;
        const payload = media?.payload;
        if (typeof payload === "string") {
          this.config.onMediaReceived(payload);
        }
        break;
      }
      case "stop":
        if (ws === this.activeWs) {
          this.activeWs = null;
          this.config.onStreamStopped();
        }
        break;
    }
  }
};

// src/telephony/twilio-bridge.ts
var TwilioBridge = class {
  constructor(config, callbacks) {
    this.config = config;
    this.callbacks = callbacks;
    this.client = twilio(config.accountSid, config.authToken);
    this.wsAuthToken = randomBytes(16).toString("hex");
    this.webhookServer = new TwilioWebhookServer({
      port: config.webhookPort,
      authToken: config.authToken,
      wsAuthToken: this.wsAuthToken,
      onMediaReceived: (base64Audio) => {
        if (this.state !== "connected") return;
        try {
          const pcm16k = twilioToFramework(base64Audio);
          this.callbacks.onAudioFromHuman(pcm16k);
        } catch (err) {
          this.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
        }
      },
      onStreamStarted: (streamSid, callSid) => {
        this.streamSid = streamSid;
        if (this.callSid && callSid !== this.callSid) {
          this.callbacks.onError(
            new Error(`CallSid mismatch: expected ${this.callSid}, got ${callSid}`)
          );
          return;
        }
        this.state = "connected";
        this.callbacks.onCallConnected(this.callSid ?? callSid);
      },
      onStreamStopped: () => {
        if (this.state === "connected" || this.state === "dialing" || this.state === "ringing") {
          this.state = "ended";
          this.callbacks.onCallEnded(this.callSid ?? "", "stream_stopped");
        }
      },
      onStatusCallback: (callSid, callStatus, answeredBy) => {
        this.handleStatusCallback(callSid, callStatus, answeredBy);
      }
    });
  }
  config;
  callbacks;
  client;
  webhookServer;
  state = "idle";
  callSid;
  wsAuthToken;
  streamSid;
  /** Start the webhook server. Must be called before dial(). */
  async start() {
    await this.webhookServer.start();
  }
  /**
   * Initiate an outbound call to the given phone number.
   * @returns The Twilio CallSid.
   */
  async dial(toNumber) {
    if (this.state !== "idle") {
      throw new Error(`Cannot dial in state "${this.state}"`);
    }
    this.state = "dialing";
    const twimlUrl = `${this.config.webhookBaseUrl}/twilio/voice?auth=${this.wsAuthToken}`;
    const statusCallbackUrl = `${this.config.webhookBaseUrl}/twilio/status`;
    const callOptions = {
      to: toNumber,
      from: this.config.fromNumber,
      url: twimlUrl,
      statusCallback: statusCallbackUrl,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      timeLimit: this.config.maxCallDuration ?? 1800,
      timeout: this.config.ringTimeout ?? 30,
      ...this.config.machineDetection && { machineDetection: "Enable" }
    };
    try {
      const call = await this.client.calls.create(callOptions);
      this.callSid = call.sid;
      return call.sid;
    } catch (err) {
      this.state = "ended";
      throw err;
    }
  }
  /**
   * Send PCM L16 16kHz audio TO the human via Twilio Media Streams.
   * Converts to mulaw 8kHz before sending.
   */
  sendAudioToHuman(pcm16kInput) {
    if (this.state !== "connected") return;
    const mulawBase64 = frameworkToTwilio(pcm16kInput);
    this.webhookServer.sendMedia(mulawBase64, this.streamSid);
  }
  /** Hang up the active call. */
  async hangup() {
    if (!this.callSid || this.state === "ended" || this.state === "disposed") return;
    try {
      await this.client.calls(this.callSid).update({ status: "completed" });
    } catch {
    }
    this.state = "ended";
  }
  /** Clean up all resources (webhook server, call). */
  async dispose() {
    if (this.state === "disposed") return;
    await this.hangup();
    await this.webhookServer.stop();
    this.state = "disposed";
  }
  /** Handle a Twilio status callback. */
  handleStatusCallback(callSid, callStatus, answeredBy) {
    if (callSid !== this.callSid) return;
    switch (callStatus) {
      case "ringing":
        this.state = "ringing";
        break;
      case "completed":
      case "busy":
      case "no-answer":
      case "failed":
      case "canceled":
        if (this.state !== "ended" && this.state !== "disposed") {
          this.state = "ended";
          const reason = answeredBy?.startsWith("machine") ? `voicemail:${answeredBy}` : callStatus;
          this.callbacks.onCallEnded(callSid, reason);
        }
        break;
    }
  }
  /** Current bridge state (for testing/inspection). */
  get currentState() {
    return this.state;
  }
};

// src/transport/cartesia-tts-provider.ts
import { WebSocket } from "ws";

// src/audio/sentence-buffer.ts
var MAX_BUFFER_CHARS = 200;
var SentenceBuffer = class {
  buffer = "";
  // Matches sentence-ending punctuation:
  // - Latin (.!?) followed by whitespace
  // - CJK (。！？) with no trailing space required
  sentencePattern = /[.!?]\s|[。！？]/g;
  /**
   * Add a text token. Returns flushed sentence(s) as an array,
   * or empty array if still buffering.
   */
  add(token) {
    this.buffer += token;
    const results = [];
    let lastIndex = 0;
    for (const match of this.buffer.matchAll(this.sentencePattern)) {
      if (match.index === void 0) continue;
      const breakpoint = match.index + match[0].length;
      results.push(this.buffer.slice(lastIndex, breakpoint));
      lastIndex = breakpoint;
    }
    if (results.length > 0) {
      this.buffer = this.buffer.slice(lastIndex);
    }
    if (results.length === 0 && this.buffer.length >= MAX_BUFFER_CHARS) {
      results.push(this.buffer);
      this.buffer = "";
    }
    return results;
  }
  /** Flush remaining buffer (end of response). Returns empty string if buffer is empty. */
  flush() {
    const remaining = this.buffer.trim();
    this.buffer = "";
    return remaining;
  }
  /** Clear without emitting (interruption). */
  clear() {
    this.buffer = "";
  }
};

// src/transport/cartesia-tts-provider.ts
var CARTESIA_VERSION = "2024-06-10";
var WS_BASE_URL = "wss://api.cartesia.ai/tts/websocket";
var CONNECT_TIMEOUT_MS = 1e4;
var SUPPORTED_SAMPLE_RATES = [8e3, 16e3, 22050, 24e3, 44100];
var CartesiaTTSProvider = class {
  // --- Config ---
  _apiKey;
  _voiceId;
  _modelId;
  _language;
  _speed;
  _emotion;
  // --- Audio format (set by configure()) ---
  _sampleRate = 0;
  // --- Connection state ---
  _state = "idle";
  _ws = null;
  // --- Sentence buffering ---
  _sentenceBuffer = new SentenceBuffer();
  // --- Context tracking ---
  /** Current requestId being synthesized. */
  _currentRequestId = null;
  /** Map from Cartesia context_id → requestId for audio/done correlation. */
  _contextToRequest = /* @__PURE__ */ new Map();
  /** Set of requestIds that have been cancelled (to suppress late callbacks). */
  _cancelledRequests = /* @__PURE__ */ new Set();
  /** Counter for generating unique context IDs within this session. */
  _contextCounter = 0;
  /** Current context ID (for the active requestId). */
  _currentContextId = null;
  /** Whether the current context has been finalized (continue: false sent). */
  _contextFinalized = false;
  // --- Start promise resolution ---
  _connectResolve = null;
  _connectReject = null;
  _connectTimer;
  // --- Callbacks (wired by VoiceSession) ---
  onAudio;
  onDone;
  onWordBoundary;
  onError;
  constructor(config) {
    if (!config.apiKey?.trim()) {
      throw new Error("CartesiaTTSProvider requires a non-empty apiKey");
    }
    if (!config.voiceId?.trim()) {
      throw new Error("CartesiaTTSProvider requires a non-empty voiceId");
    }
    this._apiKey = config.apiKey;
    this._voiceId = config.voiceId;
    this._modelId = config.modelId ?? "sonic-2";
    this._language = config.language ?? "en";
    this._speed = config.speed ?? "normal";
    this._emotion = config.emotion ?? [];
  }
  // ─── TTSProvider interface ───────────────────────────────────────────
  configure(preferred) {
    let bestRate = SUPPORTED_SAMPLE_RATES[0];
    let bestDiff = Math.abs(preferred.sampleRate - bestRate);
    for (const rate of SUPPORTED_SAMPLE_RATES) {
      const diff = Math.abs(preferred.sampleRate - rate);
      if (diff < bestDiff) {
        bestRate = rate;
        bestDiff = diff;
      }
    }
    this._sampleRate = bestRate;
    return {
      sampleRate: bestRate,
      bitDepth: 16,
      channels: 1,
      encoding: "pcm"
    };
  }
  async start() {
    if (this._state !== "idle") return;
    if (this._sampleRate === 0) {
      throw new Error("CartesiaTTSProvider: configure() must be called before start()");
    }
    this._state = "connecting";
    return this._connect();
  }
  async stop() {
    if (this._state === "stopped") return;
    this._state = "stopped";
    this._sentenceBuffer.clear();
    this._contextToRequest.clear();
    this._cancelledRequests.clear();
    this._currentRequestId = null;
    this._currentContextId = null;
    this._contextFinalized = false;
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = void 0;
    }
    if (this._connectResolve) {
      this._connectResolve = null;
      this._connectReject = null;
    }
    if (this._ws) {
      if (this._ws.readyState === WebSocket.OPEN) {
        this._ws.close(1e3, "Provider stopped");
      }
      this._ws = null;
    }
  }
  synthesize(text, requestId, options) {
    if (this._state !== "connected") return;
    if (this._currentRequestId !== null && this._currentRequestId !== requestId) {
      this._finalizeCurrentContext();
    }
    if (this._currentRequestId !== requestId) {
      this._currentRequestId = requestId;
      this._currentContextId = this._generateContextId();
      this._contextToRequest.set(this._currentContextId, requestId);
      this._contextFinalized = false;
      this._sentenceBuffer.clear();
    }
    if (!this._currentContextId) return;
    const contextId = this._currentContextId;
    const sentences = this._sentenceBuffer.add(text);
    for (const sentence of sentences) {
      this._sendTextChunk(sentence, contextId, true);
    }
    if (options?.flush) {
      const remaining = this._sentenceBuffer.flush();
      if (remaining) {
        this._sendTextChunk(remaining, contextId, false);
        this._contextFinalized = true;
      } else if (!this._contextFinalized) {
        this._sendTextChunk("", contextId, false);
        this._contextFinalized = true;
      }
    }
  }
  cancel() {
    if (this._state !== "connected") return;
    this._sentenceBuffer.clear();
    if (this._currentContextId && this._currentRequestId !== null) {
      this._send({
        context_id: this._currentContextId,
        cancel: true
      });
      this._contextToRequest.delete(this._currentContextId);
      this._currentContextId = null;
      this._currentRequestId = null;
      this._contextFinalized = false;
    }
  }
  // ─── Private helpers ─────────────────────────────────────────────────
  _connect() {
    return new Promise((resolve, reject) => {
      const url = new URL(WS_BASE_URL);
      url.searchParams.set("api_key", this._apiKey);
      url.searchParams.set("cartesia_version", CARTESIA_VERSION);
      this._ws = new WebSocket(url.toString());
      this._connectResolve = resolve;
      this._connectReject = reject;
      this._ws.on("open", () => {
        this._log("WebSocket opened");
        if (this._state === "connecting") {
          this._state = "connected";
        }
        if (this._connectResolve) {
          this._connectResolve();
          this._connectResolve = null;
          this._connectReject = null;
        }
      });
      this._ws.on("message", (data) => {
        this._handleMessage(typeof data === "string" ? data : data.toString("utf-8"));
      });
      this._ws.on("close", (code, reason) => {
        this._handleClose(code, reason.toString("utf-8"));
      });
      this._ws.on("error", (err) => {
        this._log(`WebSocket error: ${err.message}`);
        if (this._connectReject) {
          this._connectReject(err);
          this._connectResolve = null;
          this._connectReject = null;
        } else {
          this.onError?.(err, true);
        }
      });
      this._connectTimer = setTimeout(() => {
        this._connectTimer = void 0;
        if (this._connectResolve) {
          const err = new Error("CartesiaTTSProvider: connection timeout");
          this._connectResolve = null;
          if (this._connectReject) {
            this._connectReject(err);
            this._connectReject = null;
          }
        }
      }, CONNECT_TIMEOUT_MS);
    });
  }
  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this._log(`Failed to parse message: ${raw.slice(0, 100)}`);
      return;
    }
    const contextId = typeof msg.context_id === "string" ? msg.context_id : null;
    const requestId = contextId ? this._contextToRequest.get(contextId) : void 0;
    if (requestId !== void 0 && this._cancelledRequests.has(requestId)) {
      if (msg.type === "done" && contextId) {
        this._contextToRequest.delete(contextId);
        this._cancelledRequests.delete(requestId);
      }
      return;
    }
    switch (msg.type) {
      case "chunk": {
        if (requestId === void 0 || !contextId) break;
        const audioData = typeof msg.data === "string" ? msg.data : null;
        if (!audioData) break;
        const byteLength = Math.ceil(audioData.length * 3 / 4);
        const samples = byteLength / 2;
        const durationMs = samples / this._sampleRate * 1e3;
        this.onAudio?.(audioData, durationMs, requestId);
        this._parseWordTimestamps(msg, requestId);
        break;
      }
      case "done": {
        if (requestId !== void 0 && contextId) {
          this._contextToRequest.delete(contextId);
          this.onDone?.(requestId);
        }
        break;
      }
      case "timestamps": {
        if (requestId !== void 0) {
          this._parseWordTimestamps(msg, requestId);
        }
        break;
      }
      case "error": {
        const errorMsg = typeof msg.message === "string" ? msg.message : typeof msg.error === "string" ? msg.error : "Unknown Cartesia error";
        this._log(`Server error: ${errorMsg}`);
        this.onError?.(new Error(errorMsg), false);
        break;
      }
      default:
        break;
    }
  }
  _parseWordTimestamps(msg, requestId) {
    const timestamps = msg.word_timestamps;
    if (!timestamps?.words || !timestamps?.start) return;
    const words = timestamps.words;
    const starts = timestamps.start;
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const startSec = starts[i];
      if (word && startSec !== void 0) {
        this.onWordBoundary?.(word, startSec * 1e3, requestId);
      }
    }
  }
  _handleClose(code, reason) {
    this._log(`WebSocket closed: code=${code} reason="${reason}"`);
    this._ws = null;
    if (this._state === "stopped") return;
    this._state = "stopped";
    this.onError?.(
      new Error(`CartesiaTTSProvider: WebSocket closed unexpectedly (code=${code})`),
      true
    );
  }
  _sendTextChunk(text, contextId, isContinuation) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const voice = {
      mode: "id",
      id: this._voiceId
    };
    if (this._speed !== "normal" || this._emotion.length > 0) {
      const controls = {};
      if (this._speed !== "normal") controls.speed = this._speed;
      if (this._emotion.length > 0) controls.emotion = this._emotion;
      voice.__experimental_controls = controls;
    }
    this._send({
      model_id: this._modelId,
      transcript: text,
      voice,
      output_format: {
        container: "raw",
        encoding: "pcm_s16le",
        sample_rate: this._sampleRate
      },
      context_id: contextId,
      language: this._language,
      continue: isContinuation,
      add_timestamps: true
    });
  }
  _finalizeCurrentContext() {
    if (!this._currentContextId || this._contextFinalized || this._currentRequestId === null) {
      return;
    }
    const remaining = this._sentenceBuffer.flush();
    if (remaining) {
      this._sendTextChunk(remaining, this._currentContextId, false);
    } else {
      this._sendTextChunk("", this._currentContextId, false);
    }
    this._contextFinalized = true;
  }
  _generateContextId() {
    this._contextCounter++;
    return `ctx-${this._contextCounter}`;
  }
  _send(msg) {
    this._ws?.send(JSON.stringify(msg));
  }
  _log(msg) {
    const t = (/* @__PURE__ */ new Date()).toISOString().slice(11, 23);
    console.log(`${t} [CartesiaTTS] ${msg}`);
  }
};

// src/transport/elevenlabs-stt-provider.ts
import { WebSocket as WebSocket2 } from "ws";
var SUPPORTED_RATES = {
  8e3: "pcm_8000",
  16e3: "pcm_16000",
  22050: "pcm_22050",
  24e3: "pcm_24000",
  44100: "pcm_44100",
  48e3: "pcm_48000"
};
var WS_BASE_URL2 = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
var MAX_RECONNECT_BUFFER_BYTES = 64e3;
var INITIAL_BACKOFF_MS = 1e3;
var MAX_BACKOFF_MS = 1e4;
var BACKOFF_MULTIPLIER = 2;
var CONNECT_TIMEOUT_MS2 = 1e4;
var ElevenLabsSTTProvider = class {
  // --- Config ---
  _apiKey;
  _model;
  _languageCode;
  // --- Audio format (set by configure()) ---
  _sampleRate = 0;
  _audioFormat = "";
  // --- Connection state ---
  _state = "idle";
  _ws = null;
  // --- Turn attribution ---
  _pendingTurnIds = [];
  // --- Reconnection ---
  _reconnectBuffer = [];
  _reconnectBufferBytes = 0;
  _reconnectBackoff = INITIAL_BACKOFF_MS;
  _reconnectTimer = null;
  // --- Start promise resolution ---
  _sessionStartedResolve = null;
  // --- Callbacks (wired by VoiceSession) ---
  onTranscript;
  onPartialTranscript;
  constructor(config) {
    if (!config.apiKey?.trim()) {
      throw new Error("ElevenLabsSTTProvider requires a non-empty apiKey");
    }
    this._apiKey = config.apiKey;
    this._model = config.model ?? "scribe_v2";
    this._languageCode = config.languageCode ?? "en";
  }
  // ─── STTProvider interface ────────────────────────────────────────
  configure(audio) {
    if (audio.bitDepth !== 16) {
      throw new Error(`ElevenLabsSTTProvider requires bitDepth=16, got ${audio.bitDepth}`);
    }
    if (audio.channels !== 1) {
      throw new Error(`ElevenLabsSTTProvider requires channels=1 (mono), got ${audio.channels}`);
    }
    const format = SUPPORTED_RATES[audio.sampleRate];
    if (!format) {
      throw new Error(
        `ElevenLabsSTTProvider: unsupported sample rate ${audio.sampleRate}Hz. Supported: ${Object.keys(SUPPORTED_RATES).join(", ")} Hz.`
      );
    }
    this._sampleRate = audio.sampleRate;
    this._audioFormat = format;
  }
  async start() {
    if (this._state !== "idle") return;
    this._state = "connecting";
    return this._connect();
  }
  async stop() {
    if (this._state === "stopped") return;
    this._state = "stopped";
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._pendingTurnIds = [];
    this._reconnectBuffer = [];
    this._reconnectBufferBytes = 0;
    if (this._ws) {
      if (this._ws.readyState === WebSocket2.OPEN) {
        this._ws.close(1e3, "Provider stopped");
      }
      this._ws = null;
    }
  }
  feedAudio(base64Pcm) {
    if (this._state === "stopped" || this._state === "idle") return;
    if (this._state === "connected" && this._ws?.readyState === WebSocket2.OPEN) {
      this._send({
        message_type: "input_audio_chunk",
        audio_base_64: base64Pcm,
        sample_rate: this._sampleRate
      });
    } else if (this._state === "reconnecting" || this._state === "connecting") {
      this._bufferForReconnect(base64Pcm);
    }
  }
  commit(turnId) {
    this._pendingTurnIds.push(turnId);
    if (this._state === "connected" && this._ws?.readyState === WebSocket2.OPEN) {
      this._send({
        message_type: "input_audio_chunk",
        audio_base_64: "",
        commit: true
      });
    }
  }
  handleInterrupted() {
  }
  handleTurnComplete() {
  }
  // ─── Private helpers ──────────────────────────────────────────────
  _connect() {
    return new Promise((resolve, reject) => {
      const url = new URL(WS_BASE_URL2);
      url.searchParams.set("model_id", this._model);
      url.searchParams.set("audio_format", this._audioFormat);
      url.searchParams.set("sample_rate", String(this._sampleRate));
      url.searchParams.set("language_code", this._languageCode);
      url.searchParams.set("commit_strategy", "vad");
      this._ws = new WebSocket2(url.toString(), {
        headers: { "xi-api-key": this._apiKey }
      });
      this._sessionStartedResolve = resolve;
      this._ws.on("open", () => {
        this._log("WebSocket opened");
      });
      this._ws.on("message", (data) => {
        this._handleMessage(typeof data === "string" ? data : data.toString("utf-8"));
      });
      this._ws.on("close", (code, reason) => {
        this._handleClose(code, reason.toString("utf-8"));
      });
      this._ws.on("error", (err) => {
        this._log(`WebSocket error: ${err.message}`);
        if (this._sessionStartedResolve) {
          this._sessionStartedResolve = null;
          reject(err);
        }
      });
      setTimeout(() => {
        if (this._sessionStartedResolve) {
          this._sessionStartedResolve = null;
          reject(new Error("ElevenLabsSTTProvider: connection timeout"));
        }
      }, CONNECT_TIMEOUT_MS2);
    });
  }
  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this._log(`Failed to parse message: ${raw.slice(0, 100)}`);
      return;
    }
    switch (msg.message_type) {
      case "session_started":
        this._log(`Session started: ${msg.session_id}`);
        if (this._state === "connecting" || this._state === "reconnecting") {
          this._state = "connected";
          this._reconnectBackoff = INITIAL_BACKOFF_MS;
          this._flushReconnectBuffer();
        }
        if (this._sessionStartedResolve) {
          this._sessionStartedResolve();
          this._sessionStartedResolve = null;
        }
        break;
      case "partial_transcript": {
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        if (text) this.onPartialTranscript?.(text);
        break;
      }
      case "committed_transcript": {
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        if (!text) break;
        const turnId = this._pendingTurnIds.shift();
        this.onTranscript?.(text, turnId);
        break;
      }
      case "begin_utterance":
      case "end_of_utterance":
        this._log(`${msg.message_type}`);
        break;
      default:
        if (typeof msg.error === "string") {
          this._log(`Server error (${msg.message_type}): ${msg.error}`);
        }
        break;
    }
  }
  _handleClose(code, reason) {
    this._log(`WebSocket closed: code=${code} reason="${reason}"`);
    this._ws = null;
    if (this._state === "stopped") return;
    this._state = "reconnecting";
    this._scheduleReconnect();
  }
  _scheduleReconnect() {
    if (this._state !== "reconnecting") return;
    const delay = this._reconnectBackoff;
    this._log(`Reconnecting in ${delay}ms...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._state !== "reconnecting") return;
      this._connect().catch((err) => {
        this._log(`Reconnect failed: ${err.message}`);
        this._reconnectBackoff = Math.min(
          this._reconnectBackoff * BACKOFF_MULTIPLIER,
          MAX_BACKOFF_MS
        );
        if (this._state === "reconnecting") {
          this._scheduleReconnect();
        }
      });
    }, delay);
  }
  _flushReconnectBuffer() {
    if (this._reconnectBuffer.length === 0) return;
    this._log(`Flushing ${this._reconnectBuffer.length} buffered chunks`);
    for (const chunk of this._reconnectBuffer) {
      if (this._ws?.readyState === WebSocket2.OPEN) {
        this._send({
          message_type: "input_audio_chunk",
          audio_base_64: chunk,
          sample_rate: this._sampleRate
        });
      }
    }
    this._reconnectBuffer = [];
    this._reconnectBufferBytes = 0;
  }
  _bufferForReconnect(base64Pcm) {
    const chunkBytes = Math.ceil(base64Pcm.length * 3 / 4);
    while (this._reconnectBufferBytes + chunkBytes > MAX_RECONNECT_BUFFER_BYTES && this._reconnectBuffer.length > 0) {
      const dropped = this._reconnectBuffer.shift();
      if (dropped) this._reconnectBufferBytes -= Math.ceil(dropped.length * 3 / 4);
    }
    this._reconnectBuffer.push(base64Pcm);
    this._reconnectBufferBytes += chunkBytes;
  }
  _send(msg) {
    this._ws?.send(JSON.stringify(msg));
  }
  _log(msg) {
    const t = (/* @__PURE__ */ new Date()).toISOString().slice(11, 23);
    console.log(`${t} [ElevenLabsSTT] ${msg}`);
  }
};

// src/transport/elevenlabs-tts-provider.ts
import { WebSocket as WebSocket3 } from "ws";
var SUPPORTED_OUTPUT_FORMATS = {
  8e3: "pcm_8000",
  16e3: "pcm_16000",
  22050: "pcm_22050",
  24e3: "pcm_24000",
  44100: "pcm_44100"
};
var WS_BASE_URL3 = "wss://api.elevenlabs.io/v1/text-to-speech";
var CONNECT_TIMEOUT_MS3 = 1e4;
var MAX_PENDING_CHARS = 1e4;
var ElevenLabsTTSProvider = class {
  // --- Config ---
  _apiKey;
  _voiceId;
  _modelId;
  _stability;
  _similarityBoost;
  _style;
  _useSpeakerBoost;
  _languageCode;
  // --- Audio format (set by configure()) ---
  _outputFormat = "";
  _sampleRate = 0;
  // --- Connection state ---
  _state = "idle";
  _ws = null;
  // --- Text buffering ---
  _sentenceBuffer = new SentenceBuffer();
  /** Total characters sent to TTS but not yet acknowledged (pending synthesis). */
  _pendingChars = 0;
  // --- Request tracking ---
  _currentRequestId = -1;
  /** Set of requestIds for which we've sent text but not yet received final audio. */
  _pendingRequestIds = /* @__PURE__ */ new Set();
  // --- Start promise resolution ---
  _connectResolve = null;
  _connectReject = null;
  _connectTimer;
  // --- Callbacks (wired by VoiceSession before start()) ---
  onAudio;
  onDone;
  onWordBoundary;
  onError;
  constructor(config) {
    if (!config.apiKey?.trim()) {
      throw new Error("ElevenLabsTTSProvider requires a non-empty apiKey");
    }
    if (!config.voiceId?.trim()) {
      throw new Error("ElevenLabsTTSProvider requires a non-empty voiceId");
    }
    this._apiKey = config.apiKey;
    this._voiceId = config.voiceId;
    this._modelId = config.modelId ?? "eleven_flash_v2_5";
    this._stability = config.stability ?? 0.5;
    this._similarityBoost = config.similarityBoost ?? 0.75;
    this._style = config.style ?? 0;
    this._useSpeakerBoost = config.useSpeakerBoost ?? true;
    this._languageCode = config.languageCode;
  }
  // ─── TTSProvider interface ───────────────────────────────────────
  configure(preferred) {
    const format = SUPPORTED_OUTPUT_FORMATS[preferred.sampleRate];
    if (format) {
      this._outputFormat = format;
      this._sampleRate = preferred.sampleRate;
    } else {
      this._outputFormat = "pcm_24000";
      this._sampleRate = 24e3;
    }
    return {
      sampleRate: this._sampleRate,
      bitDepth: 16,
      channels: 1,
      encoding: "pcm"
    };
  }
  async start() {
    if (this._state !== "idle") return;
    if (!this._outputFormat) {
      throw new Error("ElevenLabsTTSProvider: configure() must be called before start()");
    }
    this._state = "connecting";
    return this._connect();
  }
  async stop() {
    if (this._state === "stopped" || this._state === "stopping") return;
    this._state = "stopping";
    if (this._ws?.readyState === WebSocket3.OPEN) {
      this._send({ text: "" });
    }
    this._cleanup();
    this._state = "stopped";
  }
  synthesize(text, requestId, options) {
    if (this._state !== "connected") return;
    if (this._currentRequestId !== requestId) {
      this._flushBuffer(this._currentRequestId);
      this._currentRequestId = requestId;
      this._pendingRequestIds.add(requestId);
    }
    if (this._pendingChars > MAX_PENDING_CHARS) {
      this._log(
        `Backpressure: dropping ${text.length} chars (${this._pendingChars} pending, limit ${MAX_PENDING_CHARS})`
      );
      return;
    }
    const sentences = this._sentenceBuffer.add(text);
    for (const sentence of sentences) {
      this._sendText(sentence);
      this._pendingChars += sentence.length;
    }
    if (options?.flush) {
      this._flushBuffer(requestId);
    }
  }
  cancel() {
    this._sentenceBuffer.clear();
    this._pendingChars = 0;
    if (this._ws?.readyState === WebSocket3.OPEN) {
      this._send({ text: "", flush: true });
    }
    for (const rid of this._pendingRequestIds) {
      this.onDone?.(rid);
    }
    this._pendingRequestIds.clear();
    this._closeAndReconnect();
  }
  // ─── Private helpers ─────────────────────────────────────────────
  _connect() {
    return new Promise((resolve, reject) => {
      const url = `${WS_BASE_URL3}/${encodeURIComponent(this._voiceId)}/stream-input?model_id=${encodeURIComponent(this._modelId)}&output_format=${encodeURIComponent(this._outputFormat)}`;
      this._ws = new WebSocket3(url, {
        headers: { "xi-api-key": this._apiKey }
      });
      this._connectResolve = resolve;
      this._connectReject = reject;
      this._ws.on("open", () => {
        this._log("WebSocket opened");
        this._sendBOS();
        this._state = "connected";
        if (this._connectResolve) {
          this._connectResolve();
          this._connectResolve = null;
          this._connectReject = null;
        }
      });
      this._ws.on("message", (data) => {
        this._handleMessage(typeof data === "string" ? data : data.toString("utf-8"));
      });
      this._ws.on("close", (code, reason) => {
        this._handleClose(code, reason.toString("utf-8"));
      });
      this._ws.on("error", (err) => {
        this._log(`WebSocket error: ${err.message}`);
        if (this._connectReject) {
          this._connectReject(err);
          this._connectResolve = null;
          this._connectReject = null;
        } else {
          this.onError?.(err, true);
        }
      });
      this._connectTimer = setTimeout(() => {
        this._connectTimer = void 0;
        if (this._connectResolve) {
          const err = new Error("ElevenLabsTTSProvider: connection timeout");
          this._connectResolve = null;
          if (this._connectReject) {
            this._connectReject(err);
            this._connectReject = null;
          }
        }
      }, CONNECT_TIMEOUT_MS3);
    });
  }
  /** Send Beginning of Stream (BOS) message with voice settings. */
  _sendBOS() {
    const bos = {
      text: " ",
      voice_settings: {
        stability: this._stability,
        similarity_boost: this._similarityBoost,
        style: this._style,
        use_speaker_boost: this._useSpeakerBoost
      },
      generation_config: {
        flush: true
      },
      xi_api_key: this._apiKey
    };
    if (this._languageCode) {
      bos.language_code = this._languageCode;
    }
    this._send(bos);
  }
  _sendText(text) {
    if (this._ws?.readyState !== WebSocket3.OPEN) return;
    this._send({
      text,
      try_trigger_generation: true
    });
  }
  _flushBuffer(requestId) {
    if (requestId < 0) return;
    const remaining = this._sentenceBuffer.flush();
    if (remaining) {
      this._sendText(remaining);
      this._pendingChars += remaining.length;
    }
    if (this._ws?.readyState === WebSocket3.OPEN) {
      this._send({ text: "", flush: true });
    }
  }
  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this._log(`Failed to parse message: ${raw.slice(0, 100)}`);
      return;
    }
    if (typeof msg.audio === "string" && msg.audio.length > 0) {
      const requestId = this._currentRequestId;
      if (requestId >= 0 && this._pendingRequestIds.has(requestId)) {
        const byteLength = Math.ceil(msg.audio.length * 3 / 4);
        const samples = byteLength / 2;
        const durationMs = samples / this._sampleRate * 1e3;
        this.onAudio?.(msg.audio, durationMs, requestId);
      }
    }
    const alignmentData = msg.normalizedAlignment ?? msg.alignment;
    if (alignmentData != null && typeof alignmentData === "object") {
      this._processAlignment(alignmentData);
    }
    if (msg.isFinal === true) {
      const requestId = this._currentRequestId;
      if (requestId >= 0 && this._pendingRequestIds.has(requestId)) {
        this._pendingRequestIds.delete(requestId);
        this._pendingChars = 0;
        this.onDone?.(requestId);
      }
    }
    if (typeof msg.error === "string") {
      this._log(`Server error: ${msg.error}`);
      this.onError?.(new Error(`ElevenLabs TTS error: ${msg.error}`), false);
    }
    if (typeof msg.message === "string" && msg.error !== void 0) {
      this._log(`Server message: ${msg.message}`);
    }
  }
  _processAlignment(alignment) {
    const requestId = this._currentRequestId;
    if (requestId < 0 || !this._pendingRequestIds.has(requestId)) return;
    const chars = alignment.chars;
    const startTimes = alignment.charStartTimesMs;
    if (!chars || !startTimes || chars.length === 0) return;
    let wordStart = -1;
    let currentWord = "";
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === " " || ch === "\n" || ch === "	") {
        if (currentWord && wordStart >= 0) {
          this.onWordBoundary?.(currentWord, startTimes[wordStart], requestId);
        }
        currentWord = "";
        wordStart = -1;
      } else {
        if (wordStart < 0) wordStart = i;
        currentWord += ch;
      }
    }
    if (currentWord && wordStart >= 0) {
      this.onWordBoundary?.(currentWord, startTimes[wordStart], requestId);
    }
  }
  _handleClose(code, reason) {
    this._log(`WebSocket closed: code=${code} reason="${reason}"`);
    this._ws = null;
    if (this._state === "stopped" || this._state === "stopping") return;
    this._state = "stopped";
    this.onError?.(
      new Error(`ElevenLabs TTS WebSocket closed unexpectedly: code=${code} reason="${reason}"`),
      true
    );
  }
  _closeAndReconnect() {
    if (this._ws) {
      this._ws.removeAllListeners("close");
      this._ws.removeAllListeners("error");
      if (this._ws.readyState === WebSocket3.OPEN || this._ws.readyState === WebSocket3.CONNECTING) {
        this._ws.close(1e3, "Cancel and reconnect");
      }
      this._ws = null;
    }
    if (this._state === "stopped" || this._state === "stopping") return;
    this._state = "connecting";
    this._connect().catch((err) => {
      this._log(`Reconnect failed: ${err.message}`);
      this._state = "stopped";
      this.onError?.(err, true);
    });
  }
  _cleanup() {
    this._sentenceBuffer.clear();
    this._pendingChars = 0;
    this._pendingRequestIds.clear();
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = void 0;
    }
    if (this._ws) {
      if (this._ws.readyState === WebSocket3.OPEN || this._ws.readyState === WebSocket3.CONNECTING) {
        this._ws.close(1e3, "Provider stopped");
      }
      this._ws = null;
    }
  }
  _send(msg) {
    this._ws?.send(JSON.stringify(msg));
  }
  _log(msg) {
    const t = (/* @__PURE__ */ new Date()).toISOString().slice(11, 23);
    console.log(`${t} [ElevenLabsTTS] ${msg}`);
  }
};

// src/transport/gemini-batch-stt-provider.ts
import { GoogleGenAI } from "@google/genai";
var MAX_BUFFER_BYTES = 96e4;
var MIN_DURATION_BYTES = 9600;
var MIN_RMS_THRESHOLD = 300;
var GeminiBatchSTTProvider = class {
  ai;
  model;
  sampleRate = 16e3;
  _audioChunks = [];
  _bufferBytes = 0;
  _wasInterrupted = false;
  onTranscript;
  onPartialTranscript;
  constructor(config) {
    this.ai = new GoogleGenAI({ apiKey: config.apiKey });
    this.model = config.model;
  }
  configure(audio) {
    if (audio.bitDepth !== 16) {
      throw new Error(`GeminiBatchSTTProvider requires bitDepth=16, got ${audio.bitDepth}`);
    }
    if (audio.channels !== 1) {
      throw new Error(`GeminiBatchSTTProvider requires channels=1, got ${audio.channels}`);
    }
    this.sampleRate = audio.sampleRate;
  }
  async start() {
  }
  async stop() {
    this._audioChunks = [];
    this._bufferBytes = 0;
  }
  feedAudio(base64Pcm) {
    const chunkBytes = Math.ceil(base64Pcm.length * 3 / 4);
    while (this._bufferBytes + chunkBytes > MAX_BUFFER_BYTES && this._audioChunks.length > 0) {
      const dropped = this._audioChunks.shift();
      if (dropped === void 0) break;
      this._bufferBytes -= Math.ceil(dropped.length * 3 / 4);
    }
    this._audioChunks.push(base64Pcm);
    this._bufferBytes += chunkBytes;
  }
  commit(turnId) {
    const chunks = this._audioChunks;
    this._audioChunks = [];
    this._bufferBytes = 0;
    if (chunks.length === 0) return;
    const pcmBuf = Buffer.concat(chunks.map((c) => Buffer.from(c, "base64")));
    if (pcmBuf.length === 0) return;
    if (pcmBuf.length < MIN_DURATION_BYTES || pcmRms(pcmBuf) < MIN_RMS_THRESHOLD) return;
    const wavBuf = pcmToWav(pcmBuf, this.sampleRate);
    this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                data: wavBuf.toString("base64"),
                mimeType: "audio/wav"
              }
            },
            {
              text: "Transcribe the spoken words in this audio. If the audio contains only silence, background noise, or no clear speech, respond with exactly: [SILENCE]"
            }
          ]
        }
      ]
    }).then((response) => {
      const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text && text !== "[SILENCE]") {
        this.onTranscript?.(text, turnId);
      }
    }).catch(() => {
    });
  }
  handleInterrupted() {
    this._wasInterrupted = true;
  }
  handleTurnComplete() {
    if (!this._wasInterrupted) {
      this._audioChunks = [];
      this._bufferBytes = 0;
    }
    this._wasInterrupted = false;
  }
};
function pcmRms(pcm) {
  const sampleCount = pcm.length / 2;
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}
function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// src/transport/multi-client-transport.ts
import { WebSocketServer as WebSocketServer2 } from "ws";
var MultiClientTransport = class {
  constructor(port, callbacks, host = "0.0.0.0") {
    this.port = port;
    this.callbacks = callbacks;
    this.host = host;
  }
  port;
  callbacks;
  host;
  wss = null;
  connections = /* @__PURE__ */ new Map();
  connectionCounter = 0;
  /**
   * Start the WebSocket server on its own port (standalone).
   */
  async start() {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer2({ port: this.port, host: this.host });
        this.wss.on("listening", () => {
          console.log(
            `[MultiClientTransport] WebSocket server listening on ws://${this.host}:${this.port}`
          );
          resolve();
        });
        this.wss.on("error", (error) => {
          console.error("[MultiClientTransport] Server error:", error);
          reject(error);
        });
        this.wss.on("connection", (ws, req) => {
          this.handleConnection(ws, req);
        });
      } catch (error) {
        reject(error);
      }
    });
  }
  /**
   * Attach to an existing HTTP server; handle WebSocket upgrade on the given path(s).
   * Call this instead of start() when you serve HTTP (e.g. /api) and WS on the same port.
   * Accepts both '/' and '/ws' so client works with same-origin (/) and reverse-proxy (/ws) setups.
   */
  attachToHttpServer(httpServer, wsPaths = "/") {
    this.wss = new WebSocketServer2({ noServer: true });
    const paths = Array.isArray(wsPaths) ? wsPaths : [wsPaths];
    this.wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req);
    });
    httpServer.on(
      "upgrade",
      (req, socket, head) => {
        const pathname = req.url?.split("?")[0] ?? "";
        if (!paths.includes(pathname)) {
          return;
        }
        this.wss?.handleUpgrade(req, socket, head, (ws) => {
          this.wss?.emit("connection", ws, req);
        });
      }
    );
    console.log(
      `[MultiClientTransport] WebSocket attached to HTTP server on path(s) ${paths.join(", ")}`
    );
  }
  /**
   * Stop the WebSocket server and close all connections.
   */
  async stop() {
    for (const [ws] of this.connections.entries()) {
      try {
        ws.close();
      } catch (error) {
        console.error("[MultiClientTransport] Error closing connection:", error);
      }
    }
    this.connections.clear();
    if (this.wss) {
      return new Promise((resolve) => {
        this.wss?.close(() => {
          this.wss = null;
          resolve();
        });
      });
    }
  }
  /**
   * Get connection context for a WebSocket.
   */
  getConnectionContext(ws) {
    return this.connections.get(ws) ?? null;
  }
  /**
   * Associate a session with a WebSocket connection.
   */
  associateSession(ws, sessionId) {
    const context = this.connections.get(ws);
    if (context) {
      context.sessionId = sessionId;
      context.lastActivityAt = Date.now();
    }
  }
  /**
   * Associate a user with a WebSocket connection.
   */
  associateUser(ws, userId) {
    const context = this.connections.get(ws);
    if (context) {
      context.userId = userId;
      context.lastActivityAt = Date.now();
    }
  }
  /**
   * Send audio data to a specific WebSocket connection.
   */
  sendAudioToClient(ws, data) {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
  /**
   * Send a JSON message to a specific WebSocket connection.
   */
  sendJsonToClient(ws, message) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }
  /**
   * Broadcast a message to all connected clients.
   */
  broadcast(message) {
    const json = JSON.stringify(message);
    for (const [ws] of this.connections.entries()) {
      if (ws.readyState === 1) {
        ws.send(json);
      }
    }
  }
  /**
   * Get statistics about active connections.
   */
  getStats() {
    const connectionsByUser = {};
    for (const context of this.connections.values()) {
      if (context.userId) {
        connectionsByUser[context.userId] = (connectionsByUser[context.userId] ?? 0) + 1;
      }
    }
    return {
      totalConnections: this.connections.size,
      connectionsByUser
    };
  }
  /**
   * Handle a new WebSocket connection.
   */
  handleConnection(ws, req) {
    const webSocketId = `ws_${Date.now()}_${++this.connectionCounter}`;
    const context = {
      webSocketId,
      sessionId: null,
      userId: null,
      connectedAt: Date.now(),
      lastActivityAt: Date.now(),
      request: req
    };
    this.connections.set(ws, context);
    ws.on("message", (data, isBinary) => {
      context.lastActivityAt = Date.now();
      if (isBinary) {
        this.callbacks.onAudioFromClient?.(ws, data, context);
      } else {
        try {
          const message = JSON.parse(data.toString());
          this.callbacks.onJsonFromClient?.(ws, message, context);
        } catch (error) {
          console.error("[MultiClientTransport] Failed to parse JSON message:", error);
        }
      }
    });
    ws.on("close", () => {
      this.connections.delete(ws);
      this.callbacks.onDisconnection?.(ws, context);
    });
    ws.on("error", (error) => {
      console.error("[MultiClientTransport] WebSocket error for", webSocketId, error);
      this.callbacks.onError?.(ws, error, context);
    });
    Promise.resolve(this.callbacks.onConnection?.(ws, context)).catch((error) => {
      console.error("[MultiClientTransport] Connection callback error:", error);
    });
  }
};

// src/transport/openai-realtime-transport.ts
import OpenAI from "openai";
import { OpenAIRealtimeWS } from "openai/realtime/ws";

// src/transport/openai-function-call-assembler.ts
var OpenAIFunctionCallAssembler = class {
  pending = /* @__PURE__ */ new Map();
  /** Start tracking a new function call. */
  startCall(callId, name) {
    this.pending.set(callId, {
      callId,
      name,
      argFragments: []
    });
  }
  /** Append an argument delta. */
  appendDelta(callId, delta) {
    const call = this.pending.get(callId);
    if (call) {
      call.argFragments.push(delta);
    }
  }
  /** Finalize a call and return the completed result. Returns null if unknown callId. */
  finalize(callId) {
    const call = this.pending.get(callId);
    if (!call) return null;
    this.pending.delete(callId);
    const argsString = call.argFragments.join("");
    let args;
    try {
      args = JSON.parse(argsString);
    } catch {
      args = { _raw: argsString };
    }
    return {
      callId: call.callId,
      name: call.name,
      args
    };
  }
  /** Check if a call is being assembled. */
  hasPendingCall(callId) {
    return this.pending.has(callId);
  }
  /** Number of calls currently being assembled. */
  get pendingCount() {
    return this.pending.size;
  }
  /** Clear all pending calls (e.g., on disconnect). */
  clear() {
    this.pending.clear();
  }
};

// src/transport/openai-response-state.ts
var OpenAIResponseStateTracker = class {
  _state = "idle";
  _activeResponseId = null;
  /** Current response state. */
  get state() {
    return this._state;
  }
  /** Active response ID, or null if idle. */
  get activeResponseId() {
    return this._activeResponseId;
  }
  /** Whether the model is currently generating. */
  get isGenerating() {
    return this._state === "generating";
  }
  /** Whether we are idle (safe to start new response). */
  get isIdle() {
    return this._state === "idle";
  }
  /** Model started generating a response. */
  responseCreated(responseId) {
    this._state = "generating";
    this._activeResponseId = responseId;
  }
  /** Model finished generating (done). */
  responseDone() {
    this._state = "idle";
    this._activeResponseId = null;
  }
  /** Cancel was requested. Returns true if cancel is valid. */
  requestCancel() {
    if (this._state !== "generating") {
      return false;
    }
    this._state = "cancelling";
    return true;
  }
  /** Cancel completed (response.cancelled received). */
  cancelCompleted() {
    this._state = "idle";
    this._activeResponseId = null;
  }
  /** Reset to idle (e.g., on disconnect). */
  reset() {
    this._state = "idle";
    this._activeResponseId = null;
  }
};

// src/transport/openai-session-serializer.ts
var OpenAISessionSerializer = class {
  queue = [];
  current = null;
  timeoutMs;
  constructor(timeoutMs = 15e3) {
    this.timeoutMs = timeoutMs;
  }
  /** Acquire a slot for an operation. Resolves when it's your turn. */
  async acquire(type) {
    if (!this.current) {
      this.startOperation(type);
      return;
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ type, resolve, reject });
    });
  }
  /** Release the current slot (confirmation received). */
  release() {
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.resolve();
      this.current = null;
    }
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.startOperation(next.type, next.resolve, next.reject);
      }
    }
  }
  /** Reject the current operation (e.g., on error). */
  reject(error) {
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(error);
      this.current = null;
    }
    for (const item of this.queue) {
      item.reject(error);
    }
    this.queue = [];
  }
  /** Whether an operation is currently in progress. */
  get isBusy() {
    return this.current !== null;
  }
  /** Number of operations waiting in queue. */
  get queueLength() {
    return this.queue.length;
  }
  /** Current operation type, or null. */
  get currentType() {
    return this.current?.type ?? null;
  }
  /** Reset (e.g., on disconnect). */
  reset() {
    if (this.current) {
      clearTimeout(this.current.timer);
    }
    this.current = null;
    for (const item of this.queue) {
      item.reject(new Error("Serializer reset"));
    }
    this.queue = [];
  }
  startOperation(type, existingResolve, _existingReject) {
    if (existingResolve) {
      existingResolve();
    }
    const resolve = () => {
    };
    const reject = () => {
    };
    const timer = setTimeout(() => {
      if (this.current?.type === type) {
        this.current = null;
        reject(new Error(`${type} timed out after ${this.timeoutMs}ms`));
        if (this.queue.length > 0) {
          const next = this.queue.shift();
          if (next) {
            this.startOperation(next.type, next.resolve, next.reject);
          }
        }
      }
    }, this.timeoutMs);
    this.current = { type, resolve, reject, timer };
  }
};

// src/transport/openai-realtime-transport.ts
function toolToOpenAIFunction(tool) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.parameters, "standard")
  };
}
var OpenAIRealtimeTransport = class {
  capabilities = {
    messageTruncation: true,
    turnDetection: true,
    userTranscription: true,
    inPlaceSessionUpdate: true,
    sessionResumption: false,
    contextCompression: false,
    groundingMetadata: false,
    textResponseModality: true
  };
  audioFormat = {
    inputSampleRate: 24e3,
    outputSampleRate: 24e3,
    channels: 1,
    bitDepth: 16,
    encoding: "pcm"
  };
  // --- LLMTransport callback properties ---
  onAudioOutput;
  onToolCall;
  onToolCallCancel;
  onTurnComplete;
  onInterrupted;
  onInputTranscription;
  onOutputTranscription;
  onSessionReady;
  onError;
  onClose;
  onModelTurnStart;
  onGoAway;
  onResumptionUpdate;
  onGroundingMetadata;
  onTextOutput;
  onTextDone;
  onSpeechStarted;
  onRealtimeLLMUsage;
  // --- Private state ---
  client;
  rt = null;
  _isConnected = false;
  config;
  // Stored session config (applied at connect or via updateSession)
  instructions;
  tools;
  voice;
  // Interruption tracking
  lastAssistantItemId = null;
  audioOutputMs = 0;
  // Tool call argument accumulation (OpenAI streams args incrementally)
  functionCallAssembler = new OpenAIFunctionCallAssembler();
  // when_idle scheduling: buffer tool results while model is generating
  responseState = new OpenAIResponseStateTracker();
  _pendingWhenIdle = [];
  sessionSerializer = new OpenAISessionSerializer();
  // Text mode: whether the transport is configured for text-mode responses (for TTS)
  _textMode = false;
  // Audio suppression: stop forwarding audio deltas after interruption
  _suppressAudio = false;
  constructor(config) {
    this.config = config;
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.voice = config.voice ?? "coral";
  }
  get isConnected() {
    return this._isConnected;
  }
  // --- Lifecycle ---
  async connect(transportConfig) {
    if (transportConfig) {
      this.applyTransportConfig(transportConfig);
    }
    const model = this.config.model ?? "gpt-realtime";
    this.rt = await OpenAIRealtimeWS.create(this.client, { model });
    this.wireEventListeners();
    const sessionId = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("session.created timeout \u2014 WebSocket may have failed to open")),
        15e3
      );
      this.rt?.once("session.created", (event) => {
        clearTimeout(timeout);
        resolve(event.session?.id ?? "unknown");
      });
    });
    this._isConnected = true;
    const sessionConfig = this.buildSessionConfig();
    const updatedPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("session.update timeout")), 15e3);
      this.rt?.once("session.updated", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.rtSend({ type: "session.update", session: sessionConfig });
    await updatedPromise;
    if (this.onSessionReady) this.onSessionReady(sessionId);
  }
  async disconnect() {
    this._isConnected = false;
    this.functionCallAssembler.clear();
    this._pendingWhenIdle = [];
    this.responseState.reset();
    this.sessionSerializer.reset();
    this._suppressAudio = false;
    this.lastAssistantItemId = null;
    this.audioOutputMs = 0;
    if (this.rt) {
      try {
        this.rt.close();
      } catch {
      }
      this.rt = null;
    }
  }
  async reconnect(state) {
    await this.disconnect();
    await this.connect();
    if (!this.rt) return;
    if (state?.conversationHistory?.length) {
      this.replayHistory(state.conversationHistory);
    }
    if (state?.pendingToolCalls?.length) {
      for (const pending of state.pendingToolCalls) {
        if (pending.status === "completed" && pending.result !== void 0) {
          this.rt.send({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: pending.id,
              output: typeof pending.result === "string" ? pending.result : JSON.stringify(pending.result)
            }
          });
        }
      }
    }
  }
  // --- Audio ---
  sendAudio(base64Data) {
    if (!this.rt || !this._isConnected) return;
    this.rt.send({ type: "input_audio_buffer.append", audio: base64Data });
  }
  commitAudio() {
    if (!this.rt || !this._isConnected) return;
    this.rt.send({ type: "input_audio_buffer.commit" });
  }
  clearAudio() {
    if (!this.rt || !this._isConnected) return;
    this.rt.send({ type: "input_audio_buffer.clear" });
  }
  // --- Session configuration ---
  updateSession(config) {
    if (config.instructions !== void 0) {
      this.instructions = config.instructions;
    }
    if (config.tools !== void 0) {
      this.tools = config.tools;
    }
    if (config.responseModality !== void 0) {
      this._textMode = config.responseModality === "text";
    }
    if (!this.rt || !this._isConnected) return;
    const isLegacy = this.config.protocolVersion === "legacy";
    const update = {};
    if (config.instructions !== void 0) {
      update.instructions = config.instructions;
    }
    if (config.tools !== void 0) {
      update.tools = config.tools.map(toolToOpenAIFunction);
    }
    if (config.responseModality !== void 0) {
      if (isLegacy) {
        update.modalities = config.responseModality === "text" ? ["text"] : ["audio", "text"];
      } else {
        update.output_modalities = config.responseModality === "text" ? ["text"] : ["audio"];
      }
    }
    this.rtSend({ type: "session.update", session: update });
  }
  // --- Agent transfer (in-place via session.update — no reconnect needed) ---
  async transferSession(config, state) {
    const isLegacy = this.config.protocolVersion === "legacy";
    const update = {};
    if (config.instructions !== void 0) {
      this.instructions = config.instructions;
      update.instructions = config.instructions;
    }
    if (config.tools !== void 0) {
      this.tools = config.tools;
      update.tools = config.tools.map(toolToOpenAIFunction);
    }
    if (config.responseModality !== void 0) {
      this._textMode = config.responseModality === "text";
      if (isLegacy) {
        update.modalities = config.responseModality === "text" ? ["text"] : ["audio", "text"];
      } else {
        update.output_modalities = config.responseModality === "text" ? ["text"] : ["audio"];
      }
    }
    if (!this.rt || !this._isConnected) {
      await this.connect();
      if (state?.conversationHistory?.length) {
        this.replayHistory(state.conversationHistory);
      }
      return;
    }
    await this.sessionSerializer.acquire("session.update");
    const updatedPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("transferSession timeout")), 1e4);
      this.rt?.once("session.updated", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    try {
      this.rtSend({ type: "session.update", session: update });
      await updatedPromise;
      this.sessionSerializer.release();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.sessionSerializer.reject(err);
      throw err;
    }
  }
  // --- Content injection (greetings, directives, text input) ---
  sendContent(turns, turnComplete = true) {
    if (!this.rt || !this._isConnected) return;
    for (const turn of turns) {
      if (turn.role === "assistant") {
        this.rt.send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: turn.text }]
          }
        });
      } else {
        this.rt.send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: turn.text }]
          }
        });
      }
    }
    if (turnComplete) {
      this.rt.send({ type: "response.create" });
    }
  }
  // --- File/image injection ---
  sendFile(base64Data, mimeType) {
    if (!this.rt || !this._isConnected) return;
    this.rt.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: `data:${mimeType};base64,${base64Data}`
          }
        ]
      }
    });
  }
  // --- Tool interaction ---
  sendToolResult(result) {
    if (!this.rt || !this._isConnected) return;
    const scheduling = result.scheduling ?? "immediate";
    if (scheduling === "when_idle" && this.responseState.isGenerating) {
      this._pendingWhenIdle.push(result);
      return;
    }
    if (scheduling === "interrupt" && this.responseState.isGenerating) {
      this.responseState.requestCancel();
      this.rt.send({ type: "response.cancel" });
      this.responseState.cancelCompleted();
    }
    this.rt.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: result.id,
        output: typeof result.result === "string" ? result.result : JSON.stringify(result.result)
      }
    });
    if (scheduling !== "silent") {
      this.rt.send({ type: "response.create" });
    }
  }
  // --- Generation control ---
  triggerGeneration(instructions) {
    if (!this.rt || !this._isConnected) return;
    if (instructions) {
      this.rt.send({
        type: "response.create",
        response: { instructions }
      });
    } else {
      this.rt.send({ type: "response.create" });
    }
  }
  // --- Private helpers ---
  /** Type-safe send wrapper that accepts our dynamically-built events. */
  // biome-ignore lint/suspicious/noExplicitAny: session.update events are built dynamically; SDK types are strict but compatible at runtime
  rtSend(event) {
    this.rt?.send(event);
  }
  applyTransportConfig(config) {
    if (config.auth?.type === "api_key") {
      this.client = new OpenAI({ apiKey: config.auth.apiKey });
    }
    if (config.model !== void 0) {
      this.config.model = config.model;
    }
    if (config.instructions !== void 0) {
      this.instructions = config.instructions;
    }
    if (config.tools !== void 0) {
      this.tools = config.tools;
    }
    if (config.voice !== void 0) {
      this.voice = config.voice;
    }
    if (config.transcription !== void 0) {
      this.config.transcriptionModel = config.transcription.input === false ? null : void 0;
    }
    if (config.responseModality !== void 0) {
      this._textMode = config.responseModality === "text";
    }
  }
  buildSessionConfig() {
    if (this.config.protocolVersion === "legacy") {
      return this.buildLegacySessionConfig();
    }
    const session = {
      type: "realtime",
      output_modalities: this._textMode ? ["text"] : ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24e3 },
          ...this.config.transcriptionModel !== null ? {
            transcription: {
              model: this.config.transcriptionModel ?? "gpt-4o-mini-transcribe"
            }
          } : {},
          turn_detection: this.config.turnDetection ?? {
            type: "semantic_vad",
            eagerness: "medium",
            create_response: true,
            interrupt_response: true
            // biome-ignore lint/suspicious/noExplicitAny: turn detection config passed through from user; SDK type is strict union
          },
          ...this.config.noiseReduction ? (
            // biome-ignore lint/suspicious/noExplicitAny: noise reduction config is passed through from user
            { noise_reduction: this.config.noiseReduction }
          ) : {}
        },
        ...!this._textMode ? {
          output: {
            format: { type: "audio/pcm", rate: 24e3 },
            voice: this.voice
          }
        } : {}
      }
    };
    if (this.instructions) {
      session.instructions = this.instructions;
    }
    if (this.tools?.length) {
      session.tools = this.tools.map(toolToOpenAIFunction);
    }
    return session;
  }
  /**
   * Pre-GA / legacy session shape for Azure realtime preview endpoints.
   * Flat structure: `input_audio_format`/`output_audio_format` at top
   * level, `voice`/`turn_detection`/`input_audio_transcription` as siblings.
   * Cast through `Record<string, unknown>` because the SDK's typed
   * `RealtimeSessionCreateRequest` models GA only, and Azure rejects
   * `type='realtime'` even when the SDK type passes locally.
   */
  buildLegacySessionConfig() {
    const session = {
      modalities: this._textMode ? ["text"] : ["audio", "text"],
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      turn_detection: this.config.turnDetection ?? {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 200,
        create_response: true
      }
    };
    if (!this._textMode) {
      session.voice = this.voice;
    }
    if (this.config.transcriptionModel !== null) {
      session.input_audio_transcription = {
        model: this.config.transcriptionModel ?? "whisper-1"
      };
    }
    if (this.config.noiseReduction) {
      session.input_audio_noise_reduction = this.config.noiseReduction;
    }
    if (this.instructions) {
      session.instructions = this.instructions;
    }
    if (this.tools?.length) {
      session.tools = this.tools.map(toolToOpenAIFunction);
    }
    return session;
  }
  wireEventListeners() {
    if (!this.rt) return;
    const rt = this.rt;
    const handleAudioDelta = (event) => {
      if (this._suppressAudio) return;
      if (this.onAudioOutput) this.onAudioOutput(event.delta);
      const bytes = Buffer.from(event.delta, "base64").length;
      const samples = bytes / 2;
      this.audioOutputMs += samples / 24e3 * 1e3;
    };
    rt.on("response.output_audio.delta", handleAudioDelta);
    rt.on("response.audio.delta", handleAudioDelta);
    rt.on("response.output_text.delta", (event) => {
      if (this.onTextOutput && event.delta) this.onTextOutput(event.delta);
    });
    rt.on("response.output_text.done", () => {
      if (this.onTextDone) this.onTextDone();
    });
    rt.on("response.created", (event) => {
      const responseId = event?.response?.id ?? "unknown";
      this.responseState.responseCreated(responseId);
      this._suppressAudio = false;
      if (this.onModelTurnStart) this.onModelTurnStart();
    });
    rt.on("response.output_item.added", (event) => {
      const item = event.item;
      if ("role" in item && item.role === "assistant" && item.id) {
        this.lastAssistantItemId = item.id;
        this.audioOutputMs = 0;
      }
    });
    rt.on("response.function_call_arguments.delta", (event) => {
      if (!this.functionCallAssembler.hasPendingCall(event.item_id)) {
        this.functionCallAssembler.startCall(event.item_id, "");
      }
      this.functionCallAssembler.appendDelta(event.item_id, event.delta);
    });
    rt.on("response.output_item.done", (event) => {
      const item = event.item;
      if (item.type === "function_call") {
        let args = {};
        const completed = item.id ? this.functionCallAssembler.finalize(item.id) : null;
        if (completed) {
          args = completed.args;
          if (typeof args._raw === "string") {
            if (this.onError) {
              this.onError({
                error: new Error(
                  `Failed to parse tool call arguments for ${item.name}: ${args._raw}`
                ),
                recoverable: true
              });
            }
            return;
          }
        } else if (item.arguments) {
          try {
            args = JSON.parse(item.arguments);
          } catch {
            if (this.onError) {
              this.onError({
                error: new Error(
                  `Failed to parse tool call arguments for ${item.name}: ${item.arguments}`
                ),
                recoverable: true
              });
            }
            return;
          }
        }
        if (this.onToolCall) {
          this.onToolCall([
            {
              id: item.call_id ?? item.id ?? "",
              name: item.name ?? "",
              args
            }
          ]);
        }
      }
    });
    rt.on("response.done", (event) => {
      const e = event;
      const normalized = normalizeOpenAIResponseUsage(e?.response?.usage, e?.response?.id);
      if (normalized && this.onRealtimeLLMUsage) this.onRealtimeLLMUsage(normalized);
      this.responseState.responseDone();
      this.lastAssistantItemId = null;
      this.audioOutputMs = 0;
      this.flushPendingWhenIdle();
      if (this.onTurnComplete) this.onTurnComplete();
    });
    rt.on("input_audio_buffer.speech_started", () => {
      if (this.onSpeechStarted) this.onSpeechStarted();
      if (!this.responseState.isGenerating) return;
      this._suppressAudio = true;
      this.responseState.requestCancel();
      if (this.lastAssistantItemId) {
        rt.send({
          type: "conversation.item.truncate",
          item_id: this.lastAssistantItemId,
          content_index: 0,
          audio_end_ms: Math.floor(this.audioOutputMs)
        });
      }
      if (this.onInterrupted) this.onInterrupted();
    });
    rt.on("conversation.item.input_audio_transcription.completed", (event) => {
      const e = event;
      if (this.onInputTranscription) this.onInputTranscription(e.transcript ?? "");
      const tu = normalizeOpenAITranscriptionUsage(e.usage);
      if (tu && this.onRealtimeLLMUsage) this.onRealtimeLLMUsage(tu);
    });
    const handleOutputTranscript = (event) => {
      if (this.onOutputTranscription) this.onOutputTranscription(event.delta);
    };
    rt.on("response.output_audio_transcript.delta", handleOutputTranscript);
    rt.on("response.audio_transcript.delta", handleOutputTranscript);
    rt.on("error", (error) => {
      if (this.onError) {
        const err = error instanceof Error ? error : new Error(String(error));
        const errorType = error?.error?.type ?? "";
        const nonRecoverable = errorType === "invalid_request_error" || errorType === "authentication_error";
        this.onError({ error: err, recoverable: !nonRecoverable });
      }
    });
    rt.socket.on("close", (code, reason) => {
      this._isConnected = false;
      if (this.onClose) this.onClose(code, reason.toString());
    });
  }
  /** Flush any tool results queued with 'when_idle' scheduling. */
  flushPendingWhenIdle() {
    if (!this.rt || this._pendingWhenIdle.length === 0) return;
    const queued = this._pendingWhenIdle.splice(0);
    for (const result of queued) {
      this.rt.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: result.id,
          output: typeof result.result === "string" ? result.result : JSON.stringify(result.result)
        }
      });
    }
    this.rt.send({ type: "response.create" });
  }
  replayHistory(items) {
    if (!this.rt) return;
    const rt = this.rt;
    for (const item of items) {
      switch (item.type) {
        case "text":
          if (item.role === "assistant") {
            rt.send({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: item.text }]
              }
            });
          } else {
            rt.send({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: item.text }]
              }
            });
          }
          break;
        case "tool_call":
          rt.send({
            type: "conversation.item.create",
            item: {
              type: "function_call",
              call_id: item.id,
              name: item.name,
              arguments: JSON.stringify(item.args)
            }
          });
          break;
        case "tool_result":
          rt.send({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: item.id,
              output: JSON.stringify(item.result)
            }
          });
          break;
        case "transfer":
          rt.send({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `[Agent transfer: ${item.fromAgent} \u2192 ${item.toAgent}]`
                }
              ]
            }
          });
          break;
        case "file":
          rt.send({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: `data:${item.mimeType};base64,${item.base64Data}`
                }
              ]
            }
          });
          break;
      }
    }
  }
};
export {
  AUDIO_FORMAT,
  AgentError,
  AgentRouter,
  AudioBuffer,
  BackgroundNotificationQueue,
  CancelledError,
  CartesiaTTSProvider,
  ClientSenderAdapter,
  ConversationContext,
  ConversationHistoryWriter,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_EXTRACTION_TIMEOUT_MS,
  DEFAULT_RECONNECT_TIMEOUT_MS,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  DirectiveManager,
  ElevenLabsSTTProvider,
  ElevenLabsTTSProvider,
  EventBus,
  FrameworkError,
  GeminiBatchSTTProvider,
  GeminiLiveTransport,
  HooksManager,
  InMemorySessionStore,
  InputTimeoutError,
  InteractionModeManager,
  JsonMemoryStore,
  MemoryCacheManager,
  MemoryDistiller,
  MemoryError,
  MultiClientTransport,
  MultiUserSessionManager,
  OpenAIRealtimeTransport,
  SessionCompletedError,
  SessionError,
  SessionManager,
  SubagentSessionImpl,
  ToolCallRouter,
  ToolExecutionError,
  ToolExecutor,
  TranscriptManager,
  TransportError,
  TwilioBridge,
  TwilioWebhookServer,
  ValidationError,
  VoiceSession,
  createAgentContext,
  createAskUserTool,
  decodeMulawToPcm,
  encodePcmToMulaw,
  frameworkToTwilio,
  loadConfig,
  mulawDecode,
  mulawEncode,
  resample,
  runSubagent,
  twilioToFramework,
  validateConfig,
  zodToJsonSchema
};
//# sourceMappingURL=index.js.map