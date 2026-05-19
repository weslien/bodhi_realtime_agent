// src/agent/agent-context.ts
var LANGUAGE_NAMES = {
  "en-US": "English",
  "en-GB": "English",
  en: "English",
  "zh-CN": "Mandarin Chinese (Simplified)",
  "zh-TW": "Mandarin Chinese (Traditional)",
  zh: "Mandarin Chinese",
  "es-ES": "Spanish",
  "es-MX": "Spanish",
  es: "Spanish",
  "fr-FR": "French",
  fr: "French",
  "de-DE": "German",
  de: "German",
  "ja-JP": "Japanese",
  ja: "Japanese",
  "ko-KR": "Korean",
  ko: "Korean",
  "pt-BR": "Portuguese",
  pt: "Portuguese",
  "hi-IN": "Hindi",
  hi: "Hindi",
  "ar-SA": "Arabic",
  ar: "Arabic",
  "it-IT": "Italian",
  it: "Italian",
  "nl-NL": "Dutch",
  nl: "Dutch",
  "ru-RU": "Russian",
  ru: "Russian",
  "th-TH": "Thai",
  th: "Thai",
  "vi-VN": "Vietnamese",
  vi: "Vietnamese",
  "id-ID": "Indonesian",
  id: "Indonesian"
};
function resolveInstructions(agent) {
  const base = typeof agent.instructions === "function" ? agent.instructions() : agent.instructions;
  if (!agent.language) return base;
  const langName = LANGUAGE_NAMES[agent.language] ?? agent.language;
  const directive = `You MUST respond in ${langName}. Speak only in ${langName} unless the user explicitly asks you to switch languages.`;
  return `${directive}

${base}`;
}
function createAgentContext(options) {
  return {
    sessionId: options.sessionId,
    agentName: options.agentName,
    injectSystemMessage(text) {
      options.conversationContext.addAssistantMessage(`[system] ${text}`);
    },
    getRecentTurns(count = 10) {
      const items = options.conversationContext.items;
      return items.slice(-count);
    },
    getMemoryFacts() {
      return options.memoryFacts ?? [];
    },
    requestTransfer(toAgent) {
      options.requestTransfer?.(toAgent);
    },
    stopBufferingAndDrain(handler) {
      options.stopBufferingAndDrain?.(handler);
    },
    sendJsonToClient(message) {
      options.sendJsonToClient?.(message);
    },
    sendAudioToClient(data) {
      options.sendAudioToClient?.(data);
    },
    setExternalAudioHandler(handler) {
      options.setExternalAudioHandler?.(handler);
    }
  };
}

// src/core/errors.ts
var FrameworkError = class extends Error {
  component;
  severity;
  cause;
  constructor(message, options) {
    super(message, { cause: options.cause });
    this.name = "FrameworkError";
    this.component = options.component;
    this.severity = options.severity ?? "error";
    this.cause = options.cause;
  }
};
var TransportError = class extends FrameworkError {
  constructor(message, options) {
    super(message, { component: "transport", ...options });
    this.name = "TransportError";
  }
};
var SessionError = class extends FrameworkError {
  constructor(message, options) {
    super(message, { component: "session", ...options });
    this.name = "SessionError";
  }
};
var ToolExecutionError = class extends FrameworkError {
  constructor(message, options) {
    super(message, { component: "tool", ...options });
    this.name = "ToolExecutionError";
  }
};
var AgentError = class extends FrameworkError {
  constructor(message, options) {
    super(message, { component: "agent", ...options });
    this.name = "AgentError";
  }
};
var MemoryError = class extends FrameworkError {
  constructor(message, options) {
    super(message, { component: "memory", ...options });
    this.name = "MemoryError";
  }
};
var ValidationError = class extends FrameworkError {
  constructor(message, options) {
    super(message, { component: "validation", ...options });
    this.name = "ValidationError";
  }
};

// src/agent/subagent-runner.ts
import { generateText, tool } from "ai";
import { z } from "zod";

// src/core/constants.ts
var DEFAULT_TOOL_TIMEOUT_MS = 3e4;
var DEFAULT_EXTRACTION_TIMEOUT_MS = 3e4;
var DEFAULT_CONNECT_TIMEOUT_MS = 3e4;
var DEFAULT_RECONNECT_TIMEOUT_MS = 45e3;
var DEFAULT_SUBAGENT_TIMEOUT_MS = 6e4;

// src/agent/subagent-session.ts
var CancelledError = class extends FrameworkError {
  constructor(message = "Subagent session cancelled") {
    super(message, { component: "subagent-session", severity: "warn" });
    this.name = "CancelledError";
  }
};
var InputTimeoutError = class extends FrameworkError {
  constructor(timeoutMs) {
    super(`waitForInput timed out after ${timeoutMs}ms`, {
      component: "subagent-session",
      severity: "warn"
    });
    this.name = "InputTimeoutError";
  }
};
var SessionCompletedError = class extends FrameworkError {
  constructor() {
    super("Subagent session completed while waiting for input", {
      component: "subagent-session",
      severity: "warn"
    });
    this.name = "SessionCompletedError";
  }
};
var SubagentSessionImpl = class {
  toolCallId;
  _state = "running";
  config;
  messageHandlers = [];
  stateChangeHandlers = [];
  /** At most one pending waitForInput()/nextUserInput() at a time. */
  pendingInput = null;
  /** Pending cancellation() Promise — rejects on cancel(). */
  pendingCancellation = null;
  /** UI request registry: requestId → options for mapping button clicks back to labels. */
  uiRequests = /* @__PURE__ */ new Map();
  constructor(toolCallId, config) {
    this.toolCallId = toolCallId;
    this.config = config;
  }
  get state() {
    return this._state;
  }
  // -- Message passing ----------------------------------------------------
  sendToUser(msg) {
    if (this._state === "completed" || this._state === "cancelled") {
      throw new FrameworkError(`Cannot sendToUser in state '${this._state}'`, {
        component: "subagent-session"
      });
    }
    for (const handler of this.messageHandlers) {
      handler(msg);
    }
    if (msg.blocking) {
      this.transitionTo("waiting_for_input");
    }
  }
  sendToSubagent(input) {
    if (this._state !== "waiting_for_input") {
      throw new FrameworkError(
        `Cannot sendToSubagent in state '${this._state}' (must be 'waiting_for_input')`,
        { component: "subagent-session" }
      );
    }
    this.transitionTo("running");
    if (this.pendingInput) {
      const { resolve } = this.pendingInput;
      this.pendingInput = null;
      resolve(input);
    }
  }
  trySendToSubagent(input) {
    if (this._state !== "waiting_for_input") return false;
    this.sendToSubagent(input);
    return true;
  }
  // -- UI request registry ------------------------------------------------
  registerUiRequest(requestId, options) {
    this.uiRequests.set(requestId, options);
  }
  resolveOption(requestId, selectedOptionId) {
    const options = this.uiRequests.get(requestId);
    if (!options) return void 0;
    return options.find((opt) => opt.id === selectedOptionId);
  }
  hasUiRequest(requestId) {
    return this.uiRequests.has(requestId);
  }
  // -- Async input waiting ------------------------------------------------
  waitForInput(timeoutMs) {
    if (this.pendingInput) {
      throw new FrameworkError("Only one pending waitForInput()/nextUserInput() at a time", {
        component: "subagent-session"
      });
    }
    if (this._state === "cancelled") {
      return Promise.reject(new CancelledError());
    }
    if (this._state === "completed") {
      return Promise.reject(new SessionCompletedError());
    }
    const resolvedTimeout = timeoutMs ?? this.config?.inputTimeout ?? 12e4;
    return new Promise((resolve, reject) => {
      this.pendingInput = { resolve, reject };
      const timer = setTimeout(() => {
        if (this.pendingInput?.reject === reject) {
          this.pendingInput = null;
          reject(new InputTimeoutError(resolvedTimeout));
        }
      }, resolvedTimeout);
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
    });
  }
  nextUserInput() {
    if (this.pendingInput) {
      throw new FrameworkError("Only one pending waitForInput()/nextUserInput() at a time", {
        component: "subagent-session"
      });
    }
    if (this._state === "cancelled") {
      return Promise.reject(new CancelledError());
    }
    if (this._state === "completed") {
      return Promise.reject(new SessionCompletedError());
    }
    return new Promise((resolve, reject) => {
      this.pendingInput = { resolve, reject };
    });
  }
  cancellation() {
    if (this._state === "cancelled") {
      return Promise.reject(new CancelledError());
    }
    return new Promise((_resolve, reject) => {
      this.pendingCancellation = {
        resolve: () => {
        },
        reject
      };
    });
  }
  // -- Event subscription -------------------------------------------------
  onMessage(handler) {
    this.messageHandlers.push(handler);
  }
  onStateChange(handler) {
    this.stateChangeHandlers.push(handler);
  }
  // -- Terminal transitions -----------------------------------------------
  cancel() {
    if (this._state === "cancelled") return;
    if (this._state === "completed") return;
    this.transitionTo("cancelled");
    this.rejectAllPending(new CancelledError());
  }
  complete(_result) {
    if (this._state === "completed" || this._state === "cancelled") {
      return;
    }
    this.transitionTo("completed");
    this.rejectAllPending(new SessionCompletedError());
  }
  // -- Internal -----------------------------------------------------------
  transitionTo(newState) {
    const oldState = this._state;
    if (oldState === newState) return;
    this._state = newState;
    for (const handler of this.stateChangeHandlers) {
      handler(newState, oldState);
    }
  }
  rejectAllPending(err) {
    if (this.pendingInput) {
      const { reject } = this.pendingInput;
      this.pendingInput = null;
      reject(err);
    }
    if (this.pendingCancellation) {
      const { reject } = this.pendingCancellation;
      this.pendingCancellation = null;
      reject(err);
    }
  }
};

// src/agent/subagent-runner.ts
function isSubagentDebugLogging() {
  return process.env.LOG_LEVEL === "debug";
}
function reasoningModelLabelForLog(model) {
  const m = model;
  return typeof m.modelId === "string" && m.modelId.length > 0 ? m.modelId : "(LanguageModelV1: no modelId)";
}
function buildSystemPrompt(context) {
  const parts = [];
  parts.push(`# Instructions
${context.agentInstructions}`);
  parts.push(`
# Task
${context.task.description}`);
  if (context.task.args && Object.keys(context.task.args).length > 0) {
    parts.push(`
# Task Arguments
${JSON.stringify(context.task.args, null, 2)}`);
  }
  if (context.conversationSummary) {
    parts.push(`
# Conversation Summary
${context.conversationSummary}`);
  }
  if (context.recentTurns.length > 0) {
    const turns = context.recentTurns.map((t) => `[${t.role}]: ${t.content}`).join("\n");
    parts.push(`
# Recent Conversation
${turns}`);
  }
  if (context.relevantMemoryFacts.length > 0) {
    const facts = context.relevantMemoryFacts.map((f) => `- ${f.content}`).join("\n");
    parts.push(`
# Relevant Memory
${facts}`);
  }
  return parts.join("\n");
}
function createAskUserTool(session, maxInputRetries) {
  let consecutiveTimeouts = 0;
  return tool({
    description: "Ask the user a question and wait for their response. Use this when you need information from the user to proceed. Optionally provide structured options for UI buttons.",
    parameters: z.object({
      question: z.string().describe("The question to ask the user"),
      options: z.array(
        z.object({
          id: z.string().describe('Stable identifier for this option (e.g. "opt_0")'),
          label: z.string().describe("Short display label"),
          description: z.string().describe("What this option means")
        })
      ).optional().describe(
        "Structured choices for the user. If present, sent via UI payload for clickable buttons."
      )
    }),
    execute: async ({ question, options }) => {
      consecutiveTimeouts = 0;
      const requestId = options ? crypto.randomUUID() : void 0;
      if (options && requestId) {
        session.registerUiRequest(requestId, options);
      }
      session.sendToUser({
        type: "question",
        text: question,
        blocking: true,
        uiPayload: options ? {
          type: "choice",
          requestId,
          data: { options }
        } : void 0
      });
      try {
        const text = await session.waitForInput();
        return { userResponse: text };
      } catch (err) {
        if (err instanceof InputTimeoutError) {
          consecutiveTimeouts++;
          if (consecutiveTimeouts >= maxInputRetries) {
            throw new Error(
              `User did not respond after ${consecutiveTimeouts} attempts. Aborting.`
            );
          }
          return {
            error: `The user did not respond in time. You may re-ask or try a different question. (attempt ${consecutiveTimeouts}/${maxInputRetries})`
          };
        }
        throw err;
      }
    }
  });
}
async function runSubagent(options) {
  const { config, context, hooks, model, abortSignal, session } = options;
  const maxSteps = config.maxSteps ?? 5;
  const timeoutMs = config.timeout ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  const runWallStartedAt = Date.now();
  const dbg = isSubagentDebugLogging();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort();
  abortSignal?.addEventListener("abort", onCallerAbort);
  const onAbortDispose = () => {
    config.dispose?.();
  };
  controller.signal.addEventListener("abort", onAbortDispose);
  const tools = { ...config.tools };
  if (config.interactive && session) {
    const maxRetries = config.maxInputRetries ?? 3;
    tools.ask_user = createAskUserTool(session, maxRetries);
  }
  let stepCount = 0;
  try {
    const systemPrompt = buildSystemPrompt(context);
    if (dbg) {
      const cap = 12e3;
      const body = systemPrompt.length > cap ? `${systemPrompt.slice(0, cap)}
\u2026[truncated ${systemPrompt.length - cap} chars]` : systemPrompt;
      console.log(
        `[Subagent:${config.name}] system prompt (${systemPrompt.length} chars):
${body}`
      );
      console.log(`[Subagent:${config.name}] available tools: [${Object.keys(tools).join(", ")}]`);
      console.log(
        `[Subagent:run:generateText:start] name=${config.name} modelId=${reasoningModelLabelForLog(model)} maxSteps=${maxSteps} timeoutMs=${timeoutMs}`
      );
    }
    const generateTextStartedAt = Date.now();
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: Object.keys(context.task.args).length > 0 ? `Execute the task: ${context.task.description}
Arguments: ${JSON.stringify(context.task.args)}` : `Execute the task: ${context.task.description}`,
      tools,
      maxSteps,
      abortSignal: controller.signal,
      onStepFinish: (step) => {
        stepCount++;
        if (dbg) {
          if (step.toolCalls?.length) {
            for (const tc of step.toolCalls) {
              console.log(
                `[Subagent:${config.name}] step#${stepCount} tool=${tc.toolName} args=${JSON.stringify(tc.args)}`
              );
            }
          }
          if (step.toolResults?.length) {
            for (const tr of step.toolResults) {
              const resultStr = JSON.stringify(tr.result);
              const truncated = resultStr.length > 500 ? `${resultStr.slice(0, 500)}...` : resultStr;
              console.log(
                `[Subagent:${config.name}] step#${stepCount} result(${tr.toolName})=${truncated}`
              );
            }
          }
          if (step.text) {
            const truncated = step.text.length > 300 ? `${step.text.slice(0, 300)}...` : step.text;
            console.log(`[Subagent:${config.name}] step#${stepCount} text=${truncated}`);
          }
        }
        if (hooks.onSubagentStep) {
          hooks.onSubagentStep({
            subagentName: config.name,
            stepNumber: stepCount,
            toolCalls: step.toolCalls?.map((tc) => tc.toolName) ?? [],
            tokensUsed: step.usage?.totalTokens ?? 0
          });
        }
      }
    });
    if (dbg) {
      const usage = result.usage ?? {};
      const finishReason = result.finishReason;
      console.log(
        `[Subagent:run:generateText:ok] name=${config.name} generateTextMs=${Date.now() - generateTextStartedAt} wallMs=${Date.now() - runWallStartedAt} steps=${stepCount} finishReason=${finishReason ?? "n/a"} usage=${JSON.stringify(usage)}`
      );
    }
    const subagentResult = {
      text: result.text,
      stepCount
    };
    if (session) {
      session.complete(subagentResult);
    }
    return subagentResult;
  } catch (err) {
    if (dbg) {
      console.warn(
        `[Subagent:run:generateText:error] name=${config.name} wallMs=${Date.now() - runWallStartedAt} message=${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (session) {
      session.cancel();
    }
    throw err;
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onCallerAbort);
    controller.signal.removeEventListener("abort", onAbortDispose);
    await config.dispose?.();
  }
}

// src/agent/agent-router.ts
function isHandoffDebugLogging() {
  return process.env.LOG_LEVEL === "debug";
}
function reasoningModelLabelForLog2(model) {
  const m = model;
  return typeof m.modelId === "string" && m.modelId.length > 0 ? m.modelId : "(LanguageModelV1: no modelId)";
}
var AgentRouter = class {
  constructor(sessionManager, eventBus, hooks, conversationContext, transport, clientTransport, model, getInstructionSuffix, extraTools = [], subagentCallbacks, externalAudioCallbacks) {
    this.sessionManager = sessionManager;
    this.eventBus = eventBus;
    this.hooks = hooks;
    this.conversationContext = conversationContext;
    this.transport = transport;
    this.clientTransport = clientTransport;
    this.model = model;
    this.getInstructionSuffix = getInstructionSuffix;
    this.extraTools = extraTools;
    this.subagentCallbacks = subagentCallbacks;
    this.externalAudioCallbacks = externalAudioCallbacks;
  }
  sessionManager;
  eventBus;
  hooks;
  conversationContext;
  transport;
  clientTransport;
  model;
  getInstructionSuffix;
  extraTools;
  subagentCallbacks;
  externalAudioCallbacks;
  agents = /* @__PURE__ */ new Map();
  _activeAgent = null;
  activeSubagents = /* @__PURE__ */ new Map();
  /** Response modality to include in transfer SessionUpdate (set by VoiceSession for TTS). */
  responseModality;
  registerAgents(agents) {
    for (const agent of agents) {
      this.agents.set(agent.name, agent);
    }
  }
  setInitialAgent(agentName) {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new AgentError(`Unknown agent: ${agentName}`);
    }
    this._activeAgent = agent;
  }
  get activeAgent() {
    if (!this._activeAgent) {
      throw new AgentError("No active agent \u2014 call setInitialAgent() first");
    }
    return this._activeAgent;
  }
  /**
   * Transfer the active LLM session to a different agent.
   * Uses transport.transferSession() — the transport decides whether to
   * apply in-place (OpenAI session.update) or reconnect-based (Gemini).
   */
  async transfer(toAgentName) {
    const toAgent = this.agents.get(toAgentName);
    if (!toAgent) {
      throw new AgentError(`Unknown agent: ${toAgentName}`);
    }
    const fromAgent = this.activeAgent;
    const ctx = this.createContext(fromAgent.name);
    await fromAgent.onExit?.(ctx);
    this.eventBus.publish("agent.exit", {
      sessionId: this.sessionManager.sessionId,
      agentName: fromAgent.name
    });
    this.conversationContext.addAgentTransfer(fromAgent.name, toAgentName);
    this.sessionManager.transitionTo("TRANSFERRING");
    this.clientTransport.startBuffering();
    try {
      if (toAgent.audioMode === "external") {
        await this.transport.disconnect();
        this._activeAgent = toAgent;
        const newCtx = this.createContext(toAgent.name);
        await toAgent.onEnter?.(newCtx);
        this.sessionManager.transitionTo("ACTIVE");
        this.eventBus.publish("agent.enter", {
          sessionId: this.sessionManager.sessionId,
          agentName: toAgent.name
        });
      } else {
        const suffix = this.getInstructionSuffix?.() ?? "";
        const resolvedInstructions = resolveInstructions(toAgent) + suffix;
        const allTools = [...toAgent.tools, ...this.extraTools];
        const state = {
          conversationHistory: this.conversationContext.toReplayContent()
        };
        const providerOptions = {
          ...toAgent.providerOptions ?? {}
        };
        if (toAgent.googleSearch !== void 0 && providerOptions.googleSearch === void 0) {
          providerOptions.googleSearch = toAgent.googleSearch;
        }
        await this.transport.transferSession(
          {
            instructions: resolvedInstructions,
            tools: allTools,
            providerOptions,
            ...this.responseModality ? { responseModality: this.responseModality } : {}
          },
          state
        );
        const buffered = this.clientTransport.stopBuffering();
        for (const chunk of buffered) {
          this.transport.sendAudio(chunk.toString("base64"));
        }
        this.sessionManager.transitionTo("ACTIVE");
        this._activeAgent = toAgent;
        const newCtx = this.createContext(toAgent.name);
        await toAgent.onEnter?.(newCtx);
        this.eventBus.publish("agent.enter", {
          sessionId: this.sessionManager.sessionId,
          agentName: toAgent.name
        });
      }
      this.eventBus.publish("agent.transfer", {
        sessionId: this.sessionManager.sessionId,
        fromAgent: fromAgent.name,
        toAgent: toAgentName
      });
    } catch (err) {
      this.clientTransport.stopBuffering();
      this.sessionManager.transitionTo("CLOSED");
      const error = new AgentError(
        `Transfer to "${toAgentName}" failed: ${err instanceof Error ? err.message : String(err)}`
      );
      if (this.hooks.onError) {
        this.hooks.onError({
          sessionId: this.sessionManager.sessionId,
          component: "agent-router",
          error,
          severity: "fatal"
        });
      }
      throw error;
    }
  }
  /** Look up the SubagentSession for an active interactive subagent, or null. */
  getSubagentSession(toolCallId) {
    return this.activeSubagents.get(toolCallId)?.session ?? null;
  }
  /** Find the SubagentSession that has a pending UI request with the given requestId. */
  findSessionByRequestId(requestId) {
    for (const sub of this.activeSubagents.values()) {
      if (sub.session?.hasUiRequest(requestId)) {
        return sub.session;
      }
    }
    return null;
  }
  /**
   * Spawn a background subagent to handle a tool call asynchronously.
   */
  async handoff(toolCall, subagentConfig, externalSignal) {
    const controller = new AbortController();
    const session = subagentConfig.interactive ? new SubagentSessionImpl(toolCall.toolCallId, subagentConfig) : void 0;
    const onExternalAbort = () => {
      session?.cancel();
      controller.abort();
    };
    externalSignal?.addEventListener("abort", onExternalAbort);
    if (session) {
      if (this.subagentCallbacks?.onMessage) {
        session.onMessage((msg) => this.subagentCallbacks?.onMessage?.(toolCall.toolCallId, msg));
      }
      if (this.subagentCallbacks?.onSessionEnd) {
        session.onStateChange((newState) => {
          if (newState === "completed" || newState === "cancelled") {
            this.subagentCallbacks?.onSessionEnd?.(toolCall.toolCallId);
          }
        });
      }
    }
    this.activeSubagents.set(toolCall.toolCallId, {
      controller,
      toolCallId: toolCall.toolCallId,
      configName: subagentConfig.name,
      session
    });
    this.eventBus.publish("agent.handoff", {
      sessionId: this.sessionManager.sessionId,
      agentName: this.activeAgent.name,
      subagentName: subagentConfig.name,
      toolCallId: toolCall.toolCallId
    });
    const resolvedReasoningModel = subagentConfig.reasoningModel ?? this.model;
    const handoffWallStartedAt = Date.now();
    if (isHandoffDebugLogging()) {
      console.log(
        `[AgentRouter:handoff:start] sessionId=${this.sessionManager.sessionId} toolName=${toolCall.toolName} toolCallId=${toolCall.toolCallId} subagent=${subagentConfig.name} activeAgent=${this.activeAgent.name} reasoningOverride=${Boolean(subagentConfig.reasoningModel)} resolvedModelId=${reasoningModelLabelForLog2(resolvedReasoningModel)}`
      );
    }
    try {
      const context = this.conversationContext.getSubagentContext(
        {
          description: `Execute tool: ${toolCall.toolName}`,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.args
        },
        subagentConfig.instructions,
        []
      );
      const result = await runSubagent({
        config: subagentConfig,
        context,
        hooks: this.hooks,
        model: resolvedReasoningModel,
        abortSignal: controller.signal,
        session
      });
      if (isHandoffDebugLogging()) {
        console.log(
          `[AgentRouter:handoff:ok] sessionId=${this.sessionManager.sessionId} toolName=${toolCall.toolName} toolCallId=${toolCall.toolCallId} subagent=${subagentConfig.name} wallMs=${Date.now() - handoffWallStartedAt} stepCount=${result.stepCount} textChars=${result.text?.length ?? 0}`
        );
      }
      return result;
    } catch (err) {
      if (isHandoffDebugLogging()) {
        console.warn(
          `[AgentRouter:handoff:error] sessionId=${this.sessionManager.sessionId} toolName=${toolCall.toolName} toolCallId=${toolCall.toolCallId} subagent=${subagentConfig.name} wallMs=${Date.now() - handoffWallStartedAt} message=${err instanceof Error ? err.message : String(err)}`
        );
      }
      throw err;
    } finally {
      externalSignal?.removeEventListener("abort", onExternalAbort);
      this.activeSubagents.delete(toolCall.toolCallId);
    }
  }
  /** Abort a running background subagent by its originating tool call ID. */
  cancelSubagent(toolCallId) {
    const sub = this.activeSubagents.get(toolCallId);
    if (sub) {
      sub.session?.cancel();
      sub.controller.abort();
      this.activeSubagents.delete(toolCallId);
    }
  }
  get activeSubagentCount() {
    return this.activeSubagents.size;
  }
  createContext(agentName) {
    return createAgentContext({
      sessionId: this.sessionManager.sessionId,
      agentName,
      conversationContext: this.conversationContext,
      hooks: this.hooks,
      requestTransfer: (toAgent) => {
        setImmediate(() => {
          this.eventBus.publish("agent.transfer_requested", {
            sessionId: this.sessionManager.sessionId,
            toAgent
          });
        });
      },
      stopBufferingAndDrain: (handler) => {
        const buffered = this.clientTransport.stopBuffering();
        for (const chunk of buffered) {
          handler(chunk);
        }
      },
      sendJsonToClient: (message) => {
        this.clientTransport.sendJsonToClient(message);
      },
      sendAudioToClient: (data) => {
        if (this.externalAudioCallbacks?.sendAudioToClient) {
          this.externalAudioCallbacks.sendAudioToClient(data);
          return;
        }
        this.clientTransport.sendAudioToClient(data);
      },
      setExternalAudioHandler: (handler) => {
        this.externalAudioCallbacks?.setExternalAudioHandler?.(handler);
      }
    });
  }
};

// src/audio/resample.ts
function resamplePcm(buffer, fromRate, toRate, bitDepth) {
  if (bitDepth !== 16) {
    throw new Error(`resamplePcm: only 16-bit PCM is supported, got ${bitDepth}`);
  }
  if (fromRate === toRate) {
    return buffer;
  }
  const bytesPerSample = 2;
  const srcSampleCount = Math.floor(buffer.length / bytesPerSample);
  if (srcSampleCount === 0) {
    return Buffer.alloc(0);
  }
  const ratio = fromRate / toRate;
  const dstSampleCount = Math.floor(srcSampleCount / ratio);
  if (dstSampleCount === 0) {
    return Buffer.alloc(0);
  }
  const output = Buffer.alloc(dstSampleCount * bytesPerSample);
  for (let i = 0; i < dstSampleCount; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const fraction = srcPos - srcIndex;
    const s0 = buffer.readInt16LE(srcIndex * bytesPerSample);
    let sample;
    if (srcIndex + 1 < srcSampleCount) {
      const s1 = buffer.readInt16LE((srcIndex + 1) * bytesPerSample);
      sample = s0 + fraction * (s1 - s0);
    } else {
      sample = s0;
    }
    sample = Math.max(-32768, Math.min(32767, Math.round(sample)));
    output.writeInt16LE(sample, i * bytesPerSample);
  }
  return output;
}

// src/behaviors/behavior-manager.ts
import { z as z2 } from "zod";
var BehaviorManager = class {
  categories;
  generatedTools;
  active = /* @__PURE__ */ new Map();
  setDirective;
  sendJsonToClient;
  onPresetChange;
  constructor(categories, setDirective, sendJsonToClient, onPresetChange) {
    this.categories = categories;
    this.setDirective = setDirective;
    this.sendJsonToClient = sendJsonToClient;
    this.onPresetChange = onPresetChange;
    for (const cat of categories) {
      if (cat.presets.length > 0) {
        this.active.set(cat.key, cat.presets[0].name);
      }
    }
    this.generatedTools = categories.map((cat) => this.buildTool(cat));
  }
  /** Auto-generated tools to append to agent tool lists. */
  get tools() {
    return this.generatedTools;
  }
  /** Current active preset per category. */
  get activePresets() {
    return new Map(this.active);
  }
  /** Send full catalog to a newly connected client. */
  sendCatalog() {
    this.sendJsonToClient?.({
      type: "behavior.catalog",
      categories: this.categories.map((cat) => ({
        key: cat.key,
        toolName: cat.toolName,
        presets: cat.presets.map((p) => ({ name: p.name, label: p.label })),
        active: this.active.get(cat.key)
      }))
    });
  }
  /** Handle client-initiated preset change (bypasses LLM). */
  handleClientSet(key, preset) {
    this.applyPreset(key, preset);
  }
  /**
   * Restore a previously active preset (e.g. from persisted memory).
   * Sets the directive and updates internal state but does NOT notify the client
   * (the client will receive the correct state via `sendCatalog()` on connect).
   */
  restorePreset(key, presetName) {
    const category = this.categories.find((c) => c.key === key);
    if (!category) return false;
    const preset = category.presets.find((p) => p.name === presetName);
    if (!preset) return false;
    const scope = category.scope ?? "session";
    this.setDirective(key, preset.directive, scope);
    this.active.set(key, presetName);
    return true;
  }
  /** Reset all categories to their default preset (first in list). */
  reset() {
    for (const cat of this.categories) {
      if (cat.presets.length > 0) {
        this.applyPreset(cat.key, cat.presets[0].name);
      }
    }
  }
  /** Apply a preset: set directive, update state, notify client, fire callback. */
  applyPreset(key, presetName) {
    const category = this.categories.find((c) => c.key === key);
    if (!category) return;
    const preset = category.presets.find((p) => p.name === presetName);
    if (!preset) return;
    const scope = category.scope ?? "session";
    this.setDirective(key, preset.directive, scope);
    this.active.set(key, presetName);
    this.sendJsonToClient?.({
      type: "behavior.changed",
      key,
      preset: presetName
    });
    this.onPresetChange?.(key, presetName);
  }
  /** Build a ToolDefinition for a single BehaviorCategory. */
  buildTool(category) {
    const presetNames = category.presets.map((p) => p.name);
    const enumSchema = z2.enum(presetNames);
    return {
      name: category.toolName,
      description: category.toolDescription,
      parameters: z2.object({ preset: enumSchema }),
      execution: "inline",
      execute: async (args) => {
        const { preset } = args;
        this.applyPreset(category.key, preset);
        return { key: category.key, preset, status: "applied" };
      }
    };
  }
};

// src/memory/memory-distiller.ts
import { generateObject } from "ai";
import { z as z3 } from "zod";

// src/memory/prompts.ts
var MEMORY_EXTRACTION_PROMPT = `You are a memory extraction agent for a voice assistant.
Review the recent conversation and update the user's memory file.

CURRENT DATE/TIME: {currentDateTime}

EXTRACTION RULES:
1. Extract ONLY from the user's own words. The assistant's statements are context \u2014 NEVER attribute assistant knowledge or assumptions to the user.
   WRONG: User asks "what's the weather?" \u2192 "User wants to know the weather" (transient query, not a durable fact)
   WRONG: Assistant says "San Francisco's market is complex" \u2192 "User is in San Francisco" (assistant inference, not user statement)
   RIGHT: User says "my house is in Santa Clara" \u2192 "User's house is in Santa Clara" (direct user statement)
2. Focus on DURABLE facts useful across sessions:
   - Preferences (likes, dislikes, habits, communication style preferences)
   - Entities (names of people, pets, places, organizations the user mentions about themselves)
   - Decisions (choices the user explicitly confirms)
   - Requirements (budget limits, accessibility needs, dietary restrictions)
3. SKIP transient/session-specific details:
   - Greetings, acknowledgments ("okay", "thanks", "goodbye")
   - One-time queries ("what's the news today", "what time is it")
   - Temporary situations ("I'm in the car right now", "I'm looking at this today")
4. Each fact must be a single, self-contained statement.
5. This is VOICE transcription \u2014 spelling of names and places may be approximate. Normalize obvious transcription errors when context makes the correct word clear (e.g. "Sankara" \u2192 "Santa Clara").
6. Resolve relative dates to absolute dates using the current date/time above.

MERGE RULES:
7. Your output REPLACES the entire memory file. Include ALL facts that should be retained \u2014 both existing and newly extracted.
8. When new information contradicts an existing fact, keep only the newer version.
9. Remove duplicates. Keep the most specific version.
10. If no new meaningful facts were found, return the existing memory unchanged.

EXISTING MEMORY:
{existingMemory}

RECENT CONVERSATION:
{recentTranscript}`;

// src/memory/memory-distiller.ts
var factsSchema = z3.object({
  facts: z3.array(
    z3.object({
      content: z3.string(),
      category: z3.enum(["preference", "entity", "decision", "requirement"])
    })
  )
});
var MemoryDistiller = class {
  constructor(conversationContext, memoryStore, hooks, model, config) {
    this.conversationContext = conversationContext;
    this.memoryStore = memoryStore;
    this.hooks = hooks;
    this.model = model;
    this.userId = config.userId;
    this.sessionId = config.sessionId;
    this.turnFrequency = config.turnFrequency ?? 5;
    this.extractionTimeoutMs = config.extractionTimeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS;
  }
  conversationContext;
  memoryStore;
  hooks;
  model;
  turnCount = 0;
  extractionInFlight = false;
  turnFrequency;
  extractionTimeoutMs;
  userId;
  sessionId;
  onTurnEnd() {
    this.turnCount++;
    if (this.turnCount % this.turnFrequency === 0) {
      this.extract();
    }
  }
  onCheckpoint() {
    this.extract();
  }
  async forceExtract() {
    await this.runExtraction();
  }
  extract() {
    if (this.extractionInFlight) return;
    this.runExtraction().catch((err) => {
      this.reportError(err);
    });
  }
  async runExtraction() {
    if (this.extractionInFlight) return;
    this.extractionInFlight = true;
    const startTime = Date.now();
    try {
      const recentItems = this.conversationContext.getItemsSinceCheckpoint();
      if (recentItems.length === 0) return;
      const existing = await this.memoryStore.getAll(this.userId);
      const existingMemory = existing.length > 0 ? existing.map((f) => `[${f.category}] ${f.content}`).join("\n") : "(none)";
      const recentTranscript = recentItems.map((i) => `[${i.role}]: ${i.content}`).join("\n");
      const prompt = MEMORY_EXTRACTION_PROMPT.replace(
        "{currentDateTime}",
        (/* @__PURE__ */ new Date()).toLocaleString("en-US", {
          dateStyle: "full",
          timeStyle: "short"
        })
      ).replace("{existingMemory}", existingMemory).replace("{recentTranscript}", recentTranscript);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.extractionTimeoutMs);
      try {
        const { object } = await generateObject({
          model: this.model,
          prompt,
          schema: factsSchema,
          abortSignal: controller.signal
        });
        const parsed = object;
        const facts = parsed.facts.map((f) => ({
          ...f,
          timestamp: Date.now()
        }));
        await this.memoryStore.replaceAll(this.userId, facts);
        this.conversationContext.markCheckpoint();
        if (this.hooks.onMemoryExtraction) {
          this.hooks.onMemoryExtraction({
            userId: this.userId,
            factsExtracted: facts.length,
            durationMs: Date.now() - startTime
          });
        }
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      this.extractionInFlight = false;
    }
  }
  reportError(error) {
    if (this.hooks.onError) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.hooks.onError({
        sessionId: this.sessionId,
        component: "memory-distiller",
        error: err,
        severity: "error"
      });
    }
  }
};

// src/tools/tool-executor.ts
var ToolExecutor = class {
  constructor(hooks, eventBus, sessionId, agentName, sendJsonToClient, setDirective) {
    this.hooks = hooks;
    this.eventBus = eventBus;
    this.sessionId = sessionId;
    this.agentName = agentName;
    this.sendJsonToClient = sendJsonToClient;
    this.setDirective = setDirective;
  }
  hooks;
  eventBus;
  sessionId;
  agentName;
  sendJsonToClient;
  setDirective;
  tools = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  register(tools) {
    for (const tool2 of tools) {
      this.tools.set(tool2.name, tool2);
    }
  }
  /** Execute a tool call: validate args, run with timeout, fire hooks, return result. */
  async handleToolCall(call) {
    const tool2 = this.tools.get(call.toolName);
    if (!tool2) {
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: null,
        error: `Unknown tool: ${call.toolName}`
      };
    }
    const parsed = tool2.parameters.safeParse(call.args);
    if (!parsed.success) {
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: null,
        error: `Validation failed: ${parsed.error.message}`
      };
    }
    const controller = new AbortController();
    const startedAt = Date.now();
    this.pending.set(call.toolCallId, {
      controller,
      toolName: call.toolName,
      startedAt
    });
    if (this.hooks.onToolCall) {
      this.hooks.onToolCall({
        sessionId: this.sessionId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        execution: tool2.execution,
        agentName: this.agentName
      });
    }
    this.eventBus.publish("tool.call", {
      ...call,
      sessionId: this.sessionId,
      agentName: this.agentName
    });
    const ctx = {
      toolCallId: call.toolCallId,
      agentName: this.agentName,
      sessionId: this.sessionId,
      abortSignal: controller.signal,
      sendJsonToClient: this.sendJsonToClient,
      setDirective: this.setDirective
    };
    let result;
    let executionError;
    try {
      const timeoutMs = tool2.timeout ?? DEFAULT_TOOL_TIMEOUT_MS;
      const output = await this.executeWithTimeout(tool2, parsed.data, ctx, timeoutMs, controller);
      result = {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: output
      };
    } catch (err) {
      const cause = err instanceof Error ? err : void 0;
      const message = cause?.message ?? String(err);
      result = {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: null,
        error: message
      };
      executionError = new ToolExecutionError(`Tool "${call.toolName}" failed: ${message}`, {
        cause
      });
    } finally {
      this.pending.delete(call.toolCallId);
    }
    const durationMs = Date.now() - startedAt;
    if (this.hooks.onToolResult) {
      this.hooks.onToolResult({
        toolCallId: call.toolCallId,
        durationMs,
        status: result.error ? "error" : "completed",
        error: result.error
      });
    }
    if (executionError && this.hooks.onError) {
      this.hooks.onError({
        sessionId: this.sessionId,
        component: "tool",
        error: executionError,
        severity: "error"
      });
    }
    this.eventBus.publish("tool.result", {
      ...result,
      sessionId: this.sessionId
    });
    return result;
  }
  /** Abort one or more pending tool executions and fire cancellation hooks/events. */
  cancel(toolCallIds) {
    for (const id of toolCallIds) {
      const pending = this.pending.get(id);
      if (pending) {
        pending.controller.abort();
        this.pending.delete(id);
        if (this.hooks.onToolResult) {
          this.hooks.onToolResult({
            toolCallId: id,
            durationMs: Date.now() - pending.startedAt,
            status: "cancelled"
          });
        }
      }
    }
    this.eventBus.publish("tool.cancel", {
      sessionId: this.sessionId,
      toolCallIds
    });
  }
  get pendingCount() {
    return this.pending.size;
  }
  async executeWithTimeout(tool2, args, ctx, timeoutMs, controller) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new ToolExecutionError(`Tool "${tool2.name}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      tool2.execute(args, ctx).then(resolve).catch(reject).finally(() => clearTimeout(timer));
    });
  }
};

// src/types/audio.ts
var AUDIO_FORMAT = {
  sampleRate: 16e3,
  channels: 1,
  bitDepth: 16,
  bytesPerSample: 2,
  /** 16000 samples/s * 2 bytes/sample = 32 000 bytes/s */
  bytesPerSecond: 32e3
};

// src/transport/audio-buffer.ts
var DEFAULT_MAX_DURATION_MS = 2e3;
var AudioBuffer = class {
  buffer = [];
  totalBytes = 0;
  maxBytes;
  constructor(maxDurationMs = DEFAULT_MAX_DURATION_MS) {
    this.maxBytes = Math.ceil(maxDurationMs / 1e3 * AUDIO_FORMAT.bytesPerSecond);
  }
  /** Add an audio chunk, dropping oldest chunks if the buffer is full. */
  push(chunk) {
    this.buffer.push(chunk);
    this.totalBytes += chunk.length;
    while (this.totalBytes > this.maxBytes && this.buffer.length > 1) {
      const dropped = this.buffer.shift();
      if (dropped) {
        this.totalBytes -= dropped.length;
      }
    }
  }
  /** Remove and return all buffered chunks, resetting the buffer to empty. */
  drain() {
    const chunks = this.buffer;
    this.buffer = [];
    this.totalBytes = 0;
    return chunks;
  }
  clear() {
    this.buffer = [];
    this.totalBytes = 0;
  }
  get size() {
    return this.totalBytes;
  }
  get isEmpty() {
    return this.totalBytes === 0;
  }
};

// src/transport/client-sender-adapter.ts
var ClientSenderAdapter = class {
  sender;
  audioBuffer = new AudioBuffer();
  _buffering = false;
  constructor(sender) {
    this.sender = sender;
  }
  async start() {
  }
  async stop() {
    this._buffering = false;
    this.audioBuffer.clear();
  }
  sendAudioToClient(data) {
    if (this._buffering) {
      this.audioBuffer.push(data);
    } else {
      this.sender.sendAudio(data);
    }
  }
  sendJsonToClient(message) {
    this.sender.sendJson(message);
  }
  startBuffering() {
    this._buffering = true;
    this.audioBuffer.clear();
  }
  stopBuffering() {
    this._buffering = false;
    return this.audioBuffer.drain();
  }
};

// src/transport/client-transport.ts
import { WebSocketServer } from "ws";
var ClientTransport = class {
  constructor(port, callbacks, host = "0.0.0.0", listenTimeoutMs = 1e4) {
    this.port = port;
    this.callbacks = callbacks;
    this.host = host;
    this.listenTimeoutMs = listenTimeoutMs;
  }
  port;
  callbacks;
  host;
  listenTimeoutMs;
  wss = null;
  client = null;
  audioBuffer = new AudioBuffer();
  _buffering = false;
  async start() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`ClientTransport listen timed out after ${this.listenTimeoutMs}ms`));
      }, this.listenTimeoutMs);
      this.wss = new WebSocketServer({ port: this.port, host: this.host });
      this.wss.on("listening", () => {
        clearTimeout(timer);
        resolve();
      });
      this.wss.on("connection", (ws) => {
        ws.on("message", (data, isBinary) => {
          if (isBinary) {
            if (this._buffering) {
              this.audioBuffer.push(data);
            } else {
              this.callbacks.onAudioFromClient?.(data);
            }
          } else {
            try {
              const message = JSON.parse(data.toString());
              this.callbacks.onJsonFromClient?.(message);
            } catch {
            }
          }
        });
        ws.on("close", () => {
          this.client = null;
          this.callbacks.onClientDisconnected?.();
        });
        ws.on("error", () => {
        });
        this.client = ws;
        this.callbacks.onClientConnected?.();
      });
    });
  }
  async stop() {
    this._buffering = false;
    this.audioBuffer.clear();
    if (this.client) {
      this.client.removeAllListeners();
      this.client.close();
      this.client = null;
    }
    if (this.wss) {
      return new Promise((resolve) => {
        this.wss?.close(() => {
          this.wss = null;
          resolve();
        });
      });
    }
  }
  /** Send raw PCM audio to the client as a binary frame. */
  sendAudioToClient(data) {
    if (this.client?.readyState === 1) {
      this.client.send(data);
    }
  }
  /** Send a JSON message to the client as a text frame. */
  sendJsonToClient(message) {
    if (this.client?.readyState === 1) {
      this.client.send(JSON.stringify(message));
    }
  }
  startBuffering() {
    this._buffering = true;
    this.audioBuffer.clear();
  }
  stopBuffering() {
    this._buffering = false;
    return this.audioBuffer.drain();
  }
  get isClientConnected() {
    return this.client?.readyState === 1;
  }
  get buffering() {
    return this._buffering;
  }
};

// src/transport/gemini-live-transport.ts
import { GoogleGenAI } from "@google/genai";

// src/transport/realtime-usage-normalize.ts
function isRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function readNumber(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return void 0;
}
function modalityKey(m) {
  if (typeof m === "string") return m.toLowerCase();
  if (typeof m === "number") return String(m);
  return "";
}
function aggregateGeminiModalityDetails(details, predicate) {
  if (!Array.isArray(details)) return 0;
  let sum = 0;
  for (const row of details) {
    if (!isRecord(row)) continue;
    const mod = modalityKey(row.modality ?? row.Modality);
    const count = readNumber(row, ["tokenCount", "token_count"]);
    if (count === void 0) continue;
    if (predicate(mod)) sum += count;
  }
  return sum;
}
function geminiModalityBreakdown(raw) {
  const promptDetails = raw.promptTokensDetails ?? raw.prompt_tokens_details ?? raw.promptTokensdetails;
  const responseDetails = raw.responseTokensDetails ?? raw.response_tokens_details ?? raw.responseTokensdetails;
  const cacheDetails = raw.cacheTokensDetails ?? raw.cache_tokens_details;
  const inputText = aggregateGeminiModalityDetails(promptDetails, (m) => m.includes("text"));
  const inputAudio = aggregateGeminiModalityDetails(promptDetails, (m) => m.includes("audio"));
  const inputImage = aggregateGeminiModalityDetails(promptDetails, (m) => m.includes("image"));
  const outputText = aggregateGeminiModalityDetails(responseDetails, (m) => m.includes("text"));
  const outputAudio = aggregateGeminiModalityDetails(responseDetails, (m) => m.includes("audio"));
  const cachedText = aggregateGeminiModalityDetails(cacheDetails, (m) => m.includes("text"));
  const cachedAudio = aggregateGeminiModalityDetails(cacheDetails, (m) => m.includes("audio"));
  const cachedImage = aggregateGeminiModalityDetails(cacheDetails, (m) => m.includes("image"));
  const cachedTokens = readNumber(raw, ["cachedContentTokenCount", "cached_content_token_count"]);
  const breakdown = {};
  if (inputText) breakdown.inputTextTokens = inputText;
  if (inputAudio) breakdown.inputAudioTokens = inputAudio;
  if (inputImage) breakdown.inputImageTokens = inputImage;
  if (cachedTokens !== void 0) breakdown.cachedTokens = cachedTokens;
  if (cachedText) breakdown.cachedTextTokens = cachedText;
  if (cachedAudio) breakdown.cachedAudioTokens = cachedAudio;
  if (cachedImage) breakdown.cachedImageTokens = cachedImage;
  if (outputText) breakdown.outputTextTokens = outputText;
  if (outputAudio) breakdown.outputAudioTokens = outputAudio;
  return Object.keys(breakdown).length > 0 ? breakdown : void 0;
}
function normalizeGeminiUsageMetadata(raw, phase) {
  if (!isRecord(raw)) return null;
  const input = readNumber(raw, ["promptTokenCount", "prompt_token_count"]);
  const output = readNumber(raw, ["responseTokenCount", "response_token_count"]);
  const total = readNumber(raw, ["totalTokenCount", "total_token_count"]);
  if (input === void 0 && output === void 0 && total === void 0) return null;
  return {
    provider: "gemini_live",
    kind: "response",
    phase,
    unit: "tokens",
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    modalityBreakdown: geminiModalityBreakdown(raw),
    providerRaw: raw
  };
}
function openAIModalityFromInputDetails(d) {
  const breakdown = {};
  const text = readNumber(d, ["text_tokens"]);
  const audio = readNumber(d, ["audio_tokens"]);
  const image = readNumber(d, ["image_tokens"]);
  const cached = readNumber(d, ["cached_tokens"]);
  if (text !== void 0) breakdown.inputTextTokens = text;
  if (audio !== void 0) breakdown.inputAudioTokens = audio;
  if (image !== void 0) breakdown.inputImageTokens = image;
  if (cached !== void 0) breakdown.cachedTokens = cached;
  const cachedDet = d.cached_tokens_details;
  if (isRecord(cachedDet)) {
    const ct = readNumber(cachedDet, ["text_tokens"]);
    const ca = readNumber(cachedDet, ["audio_tokens"]);
    const ci = readNumber(cachedDet, ["image_tokens"]);
    if (ct !== void 0) breakdown.cachedTextTokens = ct;
    if (ca !== void 0) breakdown.cachedAudioTokens = ca;
    if (ci !== void 0) breakdown.cachedImageTokens = ci;
  }
  return breakdown;
}
function openAIModalityFromOutputDetails(d) {
  const breakdown = {};
  const text = readNumber(d, ["text_tokens"]);
  const audio = readNumber(d, ["audio_tokens"]);
  if (text !== void 0) breakdown.outputTextTokens = text;
  if (audio !== void 0) breakdown.outputAudioTokens = audio;
  return breakdown;
}
function mergeBreakdown(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    const bv = b[k];
    if (bv === void 0) continue;
    const av = out[k];
    out[k] = av === void 0 ? bv : av + bv;
  }
  return out;
}
function normalizeOpenAIResponseUsage(raw, providerResponseId) {
  if (!isRecord(raw)) return null;
  const input = readNumber(raw, ["input_tokens"]);
  const output = readNumber(raw, ["output_tokens"]);
  const total = readNumber(raw, ["total_tokens"]);
  if (input === void 0 && output === void 0 && total === void 0) return null;
  let modality;
  const inDet = raw.input_token_details;
  const outDet = raw.output_token_details;
  if (isRecord(inDet)) {
    modality = openAIModalityFromInputDetails(inDet);
  }
  if (isRecord(outDet)) {
    const ob = openAIModalityFromOutputDetails(outDet);
    modality = modality ? mergeBreakdown(modality, ob) : ob;
  }
  return {
    provider: "openai_realtime",
    kind: "response",
    phase: "final",
    unit: "tokens",
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    modalityBreakdown: modality && Object.values(modality).some((v) => v !== void 0) ? modality : void 0,
    providerResponseId,
    providerRaw: raw
  };
}
function normalizeOpenAITranscriptionUsage(raw) {
  if (!isRecord(raw)) return null;
  const typ = raw.type;
  if (typ === "duration") {
    const seconds = readNumber(raw, ["seconds"]);
    if (seconds === void 0) return null;
    return {
      provider: "openai_realtime",
      kind: "input_transcription",
      phase: "final",
      unit: "duration_seconds",
      durationSeconds: seconds,
      providerRaw: raw
    };
  }
  const input = readNumber(raw, ["input_tokens"]);
  const output = readNumber(raw, ["output_tokens"]);
  const total = readNumber(raw, ["total_tokens"]);
  if (input === void 0 && output === void 0 && total === void 0) return null;
  let modality;
  const inDet = raw.input_token_details;
  if (isRecord(inDet)) {
    modality = openAIModalityFromInputDetails(inDet);
  }
  return {
    provider: "openai_realtime",
    kind: "input_transcription",
    phase: "final",
    unit: "tokens",
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    modalityBreakdown: modality && Object.values(modality).some((v) => v !== void 0) ? modality : void 0,
    providerRaw: raw
  };
}

// src/transport/zod-to-schema.ts
var TYPE_MAP = {
  gemini: {
    object: "OBJECT",
    string: "STRING",
    number: "NUMBER",
    boolean: "BOOLEAN",
    array: "ARRAY"
  },
  standard: {
    object: "object",
    string: "string",
    number: "number",
    boolean: "boolean",
    array: "array"
  }
};
function zodToJsonSchema(schema, format = "gemini") {
  const def = schema._def;
  if (!def) {
    return { type: TYPE_MAP[format].object, properties: {} };
  }
  return convertDef(def, format);
}
function convertDef(def, format) {
  const typeName = def.typeName;
  const t = TYPE_MAP[format];
  switch (typeName) {
    case "ZodObject": {
      const shape = def.shape?.();
      if (!shape) return { type: t.object, properties: {} };
      const properties = {};
      const required = [];
      for (const [key, value] of Object.entries(shape)) {
        const fieldDef = value._def;
        if (fieldDef.typeName === "ZodOptional") {
          properties[key] = convertDef(fieldDef.innerType._def, format);
        } else {
          properties[key] = convertDef(fieldDef, format);
          required.push(key);
        }
      }
      const result = { type: t.object, properties };
      if (required.length > 0) result.required = required;
      return result;
    }
    case "ZodString":
      return { type: t.string };
    case "ZodNumber":
      return { type: t.number };
    case "ZodBoolean":
      return { type: t.boolean };
    case "ZodArray":
      return {
        type: t.array,
        items: convertDef(def.type._def, format)
      };
    case "ZodLiteral":
      return {
        type: typeof def.value === "number" ? t.number : typeof def.value === "boolean" ? t.boolean : t.string,
        enum: [def.value]
      };
    case "ZodEnum":
      return {
        type: t.string,
        enum: def.values
      };
    case "ZodOptional":
      return convertDef(def.innerType._def, format);
    default:
      return { type: t.string };
  }
}

// src/transport/gemini-live-transport.ts
function toFunctionResponsePayload(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (value === void 0) {
    return { result: null };
  }
  return { result: value };
}
var GeminiLiveTransport = class {
  session = null;
  ai;
  callbacks;
  config;
  /** Resolves when setupComplete fires — used to make connect() await Gemini readiness. */
  setupResolver = null;
  /** Tracks whether onModelTurnStart has already fired for the current turn. */
  _modelTurnStarted = false;
  /** Whether the transport should emit text output (used by external TTS pipelines). */
  _textMode = false;
  /**
   * True when text-mode is satisfied by output audio transcription instead of
   * model text parts (native-audio model compatibility path).
   */
  _textFromOutputTranscription = false;
  /** Whether onTextDone has been fired for the current turn (prevents double-fire). */
  _textDoneFired = false;
  /** Latest Gemini `usageMetadata` for the active model turn (cleared on `turnComplete`). */
  _cachedGeminiUsage = null;
  // --- LLMTransport static properties ---
  capabilities = {
    messageTruncation: false,
    turnDetection: true,
    userTranscription: true,
    inPlaceSessionUpdate: false,
    sessionResumption: true,
    contextCompression: true,
    groundingMetadata: true,
    textResponseModality: true
  };
  audioFormat = {
    inputSampleRate: 16e3,
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
  constructor(config, callbacks) {
    this.ai = new GoogleGenAI({ apiKey: config.apiKey });
    this.config = config;
    this.callbacks = callbacks;
  }
  /** Establish a WebSocket connection to the Gemini Live API.
   *  Resolves only after Gemini sends `setupComplete`, so callers can safely
   *  send content immediately after awaiting this method.
   *
   *  Also satisfies `LLMTransport.connect(config)` — if config is provided,
   *  it is applied before connecting.
   */
  async connect(transportConfig) {
    if (transportConfig) {
      this.applyTransportConfig(transportConfig);
    }
    const setupComplete = new Promise((resolve) => {
      this.setupResolver = resolve;
    });
    const model = this.config.model ?? "gemini-live-2.5-flash-preview";
    const nativeAudioTextFallback = this._textMode && /native-audio/i.test(model);
    this._textFromOutputTranscription = nativeAudioTextFallback;
    const connectConfig = {
      // In external TTS mode, request both AUDIO and TEXT:
      // - TEXT is consumed by the app's TTS provider
      // - AUDIO is ignored by the app, but keeps native-audio models happy
      //
      // Native-audio models reject TEXT modality; for those, use AUDIO +
      // outputAudioTranscription and route transcription text to TTS.
      responseModalities: nativeAudioTextFallback ? ["AUDIO"] : this._textMode ? ["AUDIO", "TEXT"] : ["AUDIO"],
      ...this._textMode && nativeAudioTextFallback || !this._textMode ? { outputAudioTranscription: {} } : {}
    };
    if (this.config.inputAudioTranscription !== false) {
      connectConfig.inputAudioTranscription = {};
    }
    if (this.config.systemInstruction) {
      connectConfig.systemInstruction = this.config.systemInstruction;
    }
    const toolEntries = [];
    if (this.config.googleSearch) {
      toolEntries.push({ googleSearch: {} });
    }
    if (this.config.tools?.length) {
      toolEntries.push({ functionDeclarations: this.config.tools.map(toolToDeclaration) });
    }
    if (toolEntries.length > 0) {
      connectConfig.tools = toolEntries;
    }
    if (this.config.resumptionHandle) {
      connectConfig.sessionResumption = { handle: this.config.resumptionHandle };
    } else {
      connectConfig.sessionResumption = {};
    }
    if (this.config.speechConfig?.voiceName && !this._textMode) {
      connectConfig.speechConfig = {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: this.config.speechConfig.voiceName } }
      };
    }
    if (this.config.compressionConfig) {
      connectConfig.contextWindowCompression = {
        triggerTokens: this.config.compressionConfig.triggerTokens,
        slidingWindow: { targetTokens: this.config.compressionConfig.targetTokens }
      };
    }
    this.session = await this.ai.live.connect({
      model,
      config: connectConfig,
      callbacks: {
        onopen: () => {
        },
        onmessage: (msg) => this.handleMessage(msg),
        onerror: (e) => {
          const error = new Error(e.message ?? "WebSocket error");
          this.callbacks.onError?.(error);
          if (this.onError) this.onError({ error, recoverable: true });
        },
        onclose: (e) => {
          const code = e?.code;
          const reason = e?.reason;
          this.callbacks.onClose?.(code, reason);
          if (this.onClose) this.onClose(code, reason);
        }
      }
    });
    const timeoutMs = this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Gemini connect timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    await Promise.race([setupComplete, timeout]).finally(() => clearTimeout(timer));
  }
  /** Disconnect and reconnect, optionally with a new resumption handle or ReconnectState.
   *  Accepts either a string handle (legacy API) or ReconnectState (LLMTransport API).
   */
  async reconnect(stateOrHandle) {
    const timeoutMs = this.config.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.session = null;
    }, timeoutMs);
    try {
      await this.disconnect();
      if (typeof stateOrHandle === "string") {
        this.config.resumptionHandle = stateOrHandle;
      }
      await this.connect();
      if (typeof stateOrHandle === "object" && stateOrHandle?.conversationHistory?.length) {
        this.replayHistory(stateOrHandle.conversationHistory);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  async disconnect() {
    this._modelTurnStarted = false;
    this._cachedGeminiUsage = null;
    if (this.session) {
      try {
        await this.session.close();
      } catch {
      }
      this.session = null;
    }
  }
  /** Send base64-encoded PCM audio to Gemini as realtime input. */
  sendAudio(base64Data) {
    if (!this.session) return;
    this.session.sendRealtimeInput({
      media: { data: base64Data, mimeType: "audio/pcm;rate=16000" }
    });
  }
  /** Send tool execution results back to Gemini (legacy API). */
  sendToolResponse(responses, _scheduling) {
    if (!this.session) return;
    this.session.sendToolResponse({ functionResponses: responses });
  }
  /** Send text-based conversation turns to Gemini (legacy API, used for context replay). */
  sendClientContent(turns, turnComplete = true) {
    if (!this.session) return;
    this.session.sendClientContent({ turns, turnComplete });
  }
  /** Update the tool declarations (applied on next reconnect). */
  updateTools(tools) {
    this.config.tools = tools;
  }
  /** Update the system instruction (applied on next reconnect). */
  updateSystemInstruction(instruction) {
    this.config.systemInstruction = instruction;
  }
  /** Update Google Search grounding flag (applied on next reconnect). */
  updateGoogleSearch(enabled) {
    this.config.googleSearch = enabled;
  }
  get isConnected() {
    return this.session !== null;
  }
  // --- LLMTransport methods ---
  /** Send provider-neutral content turns to Gemini. Converts ContentTurn to Gemini format. */
  sendContent(turns, turnComplete = true) {
    if (!this.session) return;
    const geminiTurns = turns.map((t) => ({
      role: t.role === "assistant" ? "model" : t.role,
      parts: [{ text: t.text }]
    }));
    this.session.sendClientContent({ turns: geminiTurns, turnComplete });
  }
  /** Send a file/image to Gemini as inline data. */
  sendFile(base64Data, mimeType) {
    if (!this.session) return;
    this.session.sendClientContent({
      turns: [{ role: "user", parts: [{ inlineData: { data: base64Data, mimeType } }] }],
      turnComplete: false
    });
  }
  /** Send a tool result back to Gemini (LLMTransport API). */
  sendToolResult(result) {
    if (!this.session) return;
    this.session.sendToolResponse({
      functionResponses: [
        {
          id: result.id,
          name: result.name,
          response: toFunctionResponsePayload(result.result)
        }
      ]
    });
  }
  /** No-op for Gemini — generation is automatic after tool results and content injection. */
  triggerGeneration(_instructions) {
  }
  /** No-op for V1 — server VAD only. */
  commitAudio() {
  }
  /** No-op for V1 — server VAD only. */
  clearAudio() {
  }
  /** Update session configuration (applied on next reconnect for Gemini). */
  updateSession(config) {
    if (config.instructions !== void 0) {
      this.config.systemInstruction = config.instructions;
    }
    if (config.tools !== void 0) {
      this.config.tools = config.tools;
    }
    if (config.responseModality !== void 0) {
      this._textMode = config.responseModality === "text";
    }
    if (config.providerOptions !== void 0) {
      if (typeof config.providerOptions.googleSearch === "boolean") {
        this.config.googleSearch = config.providerOptions.googleSearch;
      }
      if (config.providerOptions.compressionConfig) {
        this.config.compressionConfig = config.providerOptions.compressionConfig;
      }
    }
  }
  /** Transfer session: update config → reconnect → replay conversation history. */
  async transferSession(config, state) {
    this.updateSession(config);
    await this.disconnect();
    await this.connect();
    if (state?.conversationHistory?.length) {
      this.replayHistory(state.conversationHistory);
    }
  }
  // --- Private helpers ---
  /** Apply LLMTransportConfig fields to the internal GeminiTransportConfig. */
  /** Merge LLMTransportConfig into the internal config. Only provided fields are applied;
   *  undefined fields preserve existing constructor values.
   */
  applyTransportConfig(config) {
    if (config.auth.type === "api_key") {
      this.ai = new GoogleGenAI({ apiKey: config.auth.apiKey });
    }
    if (config.model !== void 0) {
      this.config.model = config.model;
    }
    if (config.instructions !== void 0) {
      this.config.systemInstruction = config.instructions;
    }
    if (config.tools !== void 0) {
      this.config.tools = config.tools;
    }
    if (config.voice !== void 0) {
      this.config.speechConfig = { voiceName: config.voice };
    }
    if (config.transcription !== void 0) {
      this.config.inputAudioTranscription = config.transcription.input ?? true;
    }
    if (config.providerOptions) {
      if (typeof config.providerOptions.googleSearch === "boolean") {
        this.config.googleSearch = config.providerOptions.googleSearch;
      }
      if (config.providerOptions.compressionConfig) {
        this.config.compressionConfig = config.providerOptions.compressionConfig;
      }
    }
    if (config.responseModality !== void 0) {
      this._textMode = config.responseModality === "text";
    }
  }
  /** Convert ReplayItem[] to Gemini Content format and send as client content. */
  replayHistory(items) {
    if (!this.session || items.length === 0) return;
    const turns = [];
    for (const item of items) {
      switch (item.type) {
        case "text":
          turns.push({
            role: item.role === "assistant" ? "model" : item.role,
            parts: [{ text: item.text }]
          });
          break;
        case "tool_call":
          turns.push({
            role: "model",
            parts: [{ functionCall: { name: item.name, args: item.args } }]
          });
          break;
        case "tool_result":
          turns.push({
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: item.name,
                  response: toFunctionResponsePayload(item.result)
                }
              }
            ]
          });
          break;
        case "file":
          turns.push({
            role: "user",
            parts: [{ inlineData: { data: item.base64Data, mimeType: item.mimeType } }]
          });
          break;
        case "transfer":
          turns.push({
            role: "user",
            parts: [{ text: `[Agent transfer: ${item.fromAgent} \u2192 ${item.toAgent}]` }]
          });
          break;
      }
    }
    this.session.sendClientContent({ turns, turnComplete: false });
  }
  // biome-ignore lint/suspicious/noExplicitAny: LiveServerMessage is a complex union type
  handleMessage(msg) {
    if (msg.setupComplete) {
      if (this.setupResolver) {
        this.setupResolver();
        this.setupResolver = null;
      }
      const sessionId = msg.setupComplete.sessionId ?? "";
      this.callbacks.onSetupComplete?.(sessionId);
      if (this.onSessionReady) this.onSessionReady(sessionId);
      return;
    }
    if (msg.usageMetadata) {
      this._cachedGeminiUsage = msg.usageMetadata;
      const update = normalizeGeminiUsageMetadata(msg.usageMetadata, "update");
      if (update && this.onRealtimeLLMUsage) this.onRealtimeLLMUsage(update);
    }
    if (msg.serverContent) {
      const content = msg.serverContent;
      if (content.modelTurn?.parts) {
        if (!this._modelTurnStarted) {
          this._modelTurnStarted = true;
          this.callbacks.onModelTurnStart?.();
          if (this.onModelTurnStart) this.onModelTurnStart();
        }
        for (const part of content.modelTurn.parts) {
          if (part.inlineData?.data) {
            if (!this._textMode) {
              this.callbacks.onAudioOutput?.(part.inlineData.data);
              if (this.onAudioOutput) this.onAudioOutput(part.inlineData.data);
            }
          }
          if (part.text !== void 0 && part.text !== null && !this._textFromOutputTranscription) {
            if (this.onTextOutput) this.onTextOutput(part.text);
          }
        }
      }
      if (content.groundingMetadata) {
        this.callbacks.onGroundingMetadata?.(content.groundingMetadata);
        if (this.onGroundingMetadata) this.onGroundingMetadata(content.groundingMetadata);
      }
      if (content.inputTranscription?.text) {
        if (this.onSpeechStarted) this.onSpeechStarted();
        this.callbacks.onInputTranscription?.(content.inputTranscription.text);
        if (this.onInputTranscription) this.onInputTranscription(content.inputTranscription.text);
      }
      if (content.outputTranscription?.text) {
        this.callbacks.onOutputTranscription?.(content.outputTranscription.text);
        if (this.onOutputTranscription)
          this.onOutputTranscription(content.outputTranscription.text);
        if (this._textMode && this._textFromOutputTranscription && this.onTextOutput) {
          this.onTextOutput(content.outputTranscription.text);
        }
      }
      if (content.interrupted) {
        if (this.onSpeechStarted) this.onSpeechStarted();
        this.callbacks.onInterrupted?.();
        if (this.onInterrupted) this.onInterrupted();
      }
      if (content.turnComplete) {
        this._modelTurnStarted = false;
        if (this._textMode && !this._textDoneFired) {
          this._textDoneFired = true;
          if (this.onTextDone) this.onTextDone();
        }
        this._textDoneFired = false;
        if (this._cachedGeminiUsage) {
          const fin = normalizeGeminiUsageMetadata(this._cachedGeminiUsage, "final");
          if (fin && this.onRealtimeLLMUsage) this.onRealtimeLLMUsage(fin);
          this._cachedGeminiUsage = null;
        }
        this.callbacks.onTurnComplete?.();
        if (this.onTurnComplete) this.onTurnComplete();
      }
      return;
    }
    if (msg.toolCall?.functionCalls?.length) {
      if (!this._modelTurnStarted) {
        this._modelTurnStarted = true;
        this.callbacks.onModelTurnStart?.();
        if (this.onModelTurnStart) this.onModelTurnStart();
      }
      this.callbacks.onToolCall?.(msg.toolCall.functionCalls);
      if (this.onToolCall) this.onToolCall(msg.toolCall.functionCalls);
      return;
    }
    if (msg.toolCallCancellation?.ids?.length) {
      this.callbacks.onToolCallCancellation?.(msg.toolCallCancellation.ids);
      if (this.onToolCallCancel) this.onToolCallCancel(msg.toolCallCancellation.ids);
      return;
    }
    if (msg.goAway) {
      this.callbacks.onGoAway?.(msg.goAway.timeLeft ?? "");
      if (this.onGoAway) this.onGoAway(msg.goAway.timeLeft ?? "");
      return;
    }
    if (msg.sessionResumptionUpdate?.newHandle) {
      this.callbacks.onResumptionUpdate?.(
        msg.sessionResumptionUpdate.newHandle,
        msg.sessionResumptionUpdate.resumable ?? false
      );
      if (this.onResumptionUpdate) {
        this.onResumptionUpdate(
          msg.sessionResumptionUpdate.newHandle,
          msg.sessionResumptionUpdate.resumable ?? false
        );
      }
    }
  }
};
function toolToDeclaration(tool2) {
  return {
    name: tool2.name,
    description: tool2.description,
    parameters: zodToJsonSchema(tool2.parameters)
  };
}

// src/core/background-notification-queue.ts
var BackgroundNotificationQueue = class {
  constructor(sendContent, log, messageTruncation = false) {
    this.sendContent = sendContent;
    this.log = log;
    this.messageTruncation = messageTruncation;
  }
  sendContent;
  log;
  messageTruncation;
  queue = [];
  audioReceived = false;
  interrupted = false;
  /**
   * Send a notification immediately if the model is idle, or queue it if
   * the model is currently generating audio.
   *
   * High-priority messages attempt immediate delivery when the transport
   * supports message truncation (OpenAI). On non-truncation transports (Gemini),
   * high-priority messages are queued at the front of the queue.
   */
  sendOrQueue(turns, turnComplete, options) {
    const priority = options?.priority ?? "normal";
    if (priority === "high") {
      if (this.audioReceived && !this.messageTruncation) {
        this.log("High-priority notification queued at front (transport cannot truncate)");
        this.queue.unshift({ turns, turnComplete, priority });
      } else {
        this.sendContent(turns, turnComplete);
      }
      return;
    }
    if (this.audioReceived) {
      this.log("LLM is generating \u2014 queuing background notification");
      this.queue.push({ turns, turnComplete, priority });
    } else {
      this.sendContent(turns, turnComplete);
    }
  }
  /** Mark that the first audio chunk has been received this turn. */
  markAudioReceived() {
    this.audioReceived = true;
  }
  /** Mark that the current turn was interrupted by the user. */
  markInterrupted() {
    this.interrupted = true;
  }
  /**
   * Handle turn completion: reset audio/interruption flags and flush one
   * queued notification (unless the turn was interrupted).
   */
  onTurnComplete() {
    this.audioReceived = false;
    const wasInterrupted = this.interrupted;
    this.interrupted = false;
    if (!wasInterrupted) {
      this.flushOne();
    }
  }
  /** Reset audio flag without flushing (used when starting a new greeting). */
  resetAudio() {
    this.audioReceived = false;
  }
  /** Drop all queued notifications (used on session close). */
  clear() {
    this.queue = [];
  }
  flushOne() {
    const notification = this.queue.shift();
    if (notification) {
      this.log(`Flushing queued background notification (${this.queue.length} remaining)`);
      this.sendContent(notification.turns, notification.turnComplete);
    }
  }
};

// src/core/conversation-context.ts
var ConversationContext = class {
  _items = [];
  _summary = null;
  checkpointIndex = 0;
  get items() {
    return this._items;
  }
  get summary() {
    return this._summary;
  }
  /** Rough token count estimate for all items + summary (content.length / 4). */
  get tokenEstimate() {
    let total = 0;
    for (const item of this._items) {
      total += item.content.length / 4;
    }
    if (this._summary) {
      total += this._summary.length / 4;
    }
    return Math.ceil(total);
  }
  addUserMessage(content) {
    this._items.push({ role: "user", content, timestamp: Date.now() });
  }
  addAssistantMessage(content) {
    this._items.push({ role: "assistant", content, timestamp: Date.now() });
  }
  addToolCall(call) {
    this._items.push({
      role: "tool_call",
      content: JSON.stringify(call),
      timestamp: Date.now()
    });
  }
  addToolResult(result) {
    this._items.push({
      role: "tool_result",
      content: JSON.stringify(result),
      timestamp: Date.now()
    });
  }
  addAgentTransfer(fromAgent, toAgent) {
    this._items.push({
      role: "transfer",
      content: `Transfer: ${fromAgent} \u2192 ${toAgent}`,
      timestamp: Date.now()
    });
  }
  /** Return all items added since the last checkpoint (or all items if no checkpoint set). */
  getItemsSinceCheckpoint() {
    return this._items.slice(this.checkpointIndex);
  }
  /** Advance the checkpoint cursor to the current end of the items list. */
  markCheckpoint() {
    this.checkpointIndex = this._items.length;
  }
  /**
   * Load existing items (e.g. when resuming from persisted history).
   * Appends to the timeline and advances the checkpoint so these items are not
   * re-flushed by ConversationHistoryWriter.
   */
  loadItems(items) {
    for (const item of items) {
      this._items.push(item);
    }
    this.checkpointIndex = this._items.length;
  }
  /** Store a compressed summary and evict all items before the current checkpoint. */
  setSummary(summary) {
    this._summary = summary;
    this._items = this._items.slice(this.checkpointIndex);
    this.checkpointIndex = 0;
  }
  /** Build a snapshot of conversation state for a subagent (summary + recent turns + memory). */
  getSubagentContext(task, agentInstructions, memoryFacts, recentTurnCount = 10) {
    const recentTurns = this._items.slice(-recentTurnCount);
    return {
      task,
      conversationSummary: this._summary,
      recentTurns,
      relevantMemoryFacts: memoryFacts,
      agentInstructions
    };
  }
  /** Format the conversation as provider-neutral ReplayItem[] for replay after reconnection. */
  toReplayContent() {
    const items = [];
    if (this._summary) {
      items.push({ type: "text", role: "user", text: `[Context summary]: ${this._summary}` });
    }
    for (const item of this._items) {
      if (item.role === "tool_call") {
        try {
          const parsed = JSON.parse(item.content);
          items.push({
            type: "tool_call",
            id: parsed.toolCallId,
            name: parsed.toolName,
            args: parsed.args ?? {}
          });
        } catch {
          items.push({ type: "text", role: "assistant", text: item.content });
        }
      } else if (item.role === "tool_result") {
        try {
          const parsed = JSON.parse(item.content);
          items.push({
            type: "tool_result",
            id: parsed.toolCallId,
            name: parsed.toolName,
            result: parsed.result
          });
        } catch {
          items.push({ type: "text", role: "assistant", text: item.content });
        }
      } else if (item.role === "transfer") {
        const match = item.content.match(/Transfer:\s*(.+?)\s*→\s*(.+)/);
        if (match) {
          items.push({ type: "transfer", fromAgent: match[1], toAgent: match[2] });
        } else {
          items.push({ type: "text", role: "assistant", text: item.content });
        }
      } else {
        const role = item.role === "user" ? "user" : "assistant";
        items.push({ type: "text", role, text: item.content });
      }
    }
    return items;
  }
};

// src/core/conversation-history-writer.ts
var ConversationHistoryWriter = class {
  constructor(sessionId, userId, initialAgentName, eventBus, conversationContext, store) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.initialAgentName = initialAgentName;
    this.eventBus = eventBus;
    this.conversationContext = conversationContext;
    this.store = store;
    this.subscribe();
  }
  sessionId;
  userId;
  initialAgentName;
  eventBus;
  conversationContext;
  store;
  unsubscribers = [];
  analytics = {
    turnCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    agentTransferCount: 0
  };
  subscribe() {
    this.unsubscribers.push(
      this.eventBus.subscribe("session.start", (payload) => {
        if (payload.sessionId !== this.sessionId) return;
        this.handleSessionStart(payload.agentName);
      }),
      this.eventBus.subscribe("turn.end", (payload) => {
        if (payload.sessionId !== this.sessionId) return;
        this.handleTurnEnd();
      }),
      this.eventBus.subscribe("agent.transfer", (payload) => {
        if (payload.sessionId !== this.sessionId) return;
        this.analytics.agentTransferCount++;
        this.flush();
      }),
      this.eventBus.subscribe("session.close", (payload) => {
        if (payload.sessionId !== this.sessionId) return;
        this.handleSessionClose(payload.reason);
      })
    );
  }
  dispose() {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }
  handleSessionStart(agentName) {
    this.store.createSession({
      id: this.sessionId,
      userId: this.userId,
      initialAgentName: agentName,
      status: "active",
      startedAt: Date.now()
    });
  }
  handleTurnEnd() {
    this.analytics.turnCount++;
    this.flush();
  }
  handleSessionClose(reason) {
    this.flush();
    const items = [...this.conversationContext.items];
    this.store.saveSessionReport({
      id: this.sessionId,
      userId: this.userId,
      initialAgentName: this.initialAgentName,
      status: "ended",
      startedAt: 0,
      disconnectReason: this.mapReason(reason),
      analytics: { ...this.analytics },
      items,
      pendingToolCalls: []
    });
    this.dispose();
  }
  flush() {
    const items = this.conversationContext.getItemsSinceCheckpoint();
    if (items.length === 0) return;
    this.updateAnalytics(items);
    this.store.addItems(this.sessionId, items);
    this.conversationContext.markCheckpoint();
  }
  updateAnalytics(items) {
    for (const item of items) {
      if (item.role === "user") this.analytics.userMessageCount++;
      else if (item.role === "assistant") this.analytics.assistantMessageCount++;
      else if (item.role === "tool_call") this.analytics.toolCallCount++;
    }
  }
  mapReason(reason) {
    const map = {
      user_hangup: "user_hangup",
      error: "error",
      timeout: "timeout",
      go_away: "go_away",
      transfer: "transfer"
    };
    return map[reason];
  }
};

// src/core/directive-manager.ts
var DirectiveManager = class {
  agentDirectives = /* @__PURE__ */ new Map();
  sessionDirectives = /* @__PURE__ */ new Map();
  /** Set or delete a directive. Defaults to agent scope if not specified. */
  set(key, value, scope) {
    const map = (scope ?? "agent") === "session" ? this.sessionDirectives : this.agentDirectives;
    if (value === null) map.delete(key);
    else map.set(key, value);
  }
  /** Clear agent-scoped directives (called on agent transfer). */
  clearAgent() {
    this.agentDirectives.clear();
  }
  /** Returns session-scoped directives formatted as a system instruction suffix. */
  getSessionSuffix() {
    if (this.sessionDirectives.size === 0) return "";
    const text = [...this.sessionDirectives.values()].join("\n\n");
    return `

[SESSION DIRECTIVES \u2014 user preferences that persist across agents]
${text}`;
  }
  /**
   * Merge both directive maps and return formatted reinforcement text.
   * Agent directives override session directives with the same key.
   * Returns empty string if no directives are set.
   */
  getReinforcementText() {
    if (this.sessionDirectives.size === 0 && this.agentDirectives.size === 0) return "";
    const merged = new Map([...this.sessionDirectives, ...this.agentDirectives]);
    return `[SYSTEM DIRECTIVES \u2014 follow these instructions]
${[...merged.values()].join("\n\n")}`;
  }
};

// src/core/event-bus.ts
var EventBus = class {
  handlers = /* @__PURE__ */ new Map();
  publish(event, payload) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[EventBus] handler error for "${event}":`, err);
      }
    }
  }
  subscribe(event, handler) {
    let set = this.handlers.get(event);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.handlers.set(event, set);
    }
    const captured = set;
    captured.add(handler);
    return () => {
      captured.delete(handler);
      if (captured.size === 0) {
        this.handlers.delete(event);
      }
    };
  }
  clear() {
    this.handlers.clear();
  }
};

// src/core/hooks.ts
var HooksManager = class {
  hooks = {};
  /** Register (or overwrite) hook callbacks. Merges with any previously registered hooks. */
  register(hooks) {
    Object.assign(this.hooks, hooks);
  }
  get onSessionStart() {
    return this.hooks.onSessionStart;
  }
  get onSessionEnd() {
    return this.hooks.onSessionEnd;
  }
  get onTurnLatency() {
    return this.hooks.onTurnLatency;
  }
  get onToolCall() {
    return this.hooks.onToolCall;
  }
  get onToolResult() {
    return this.hooks.onToolResult;
  }
  get onAgentTransfer() {
    return this.hooks.onAgentTransfer;
  }
  get onSubagentStep() {
    return this.hooks.onSubagentStep;
  }
  get onRealtimeLLMUsage() {
    return this.hooks.onRealtimeLLMUsage;
  }
  get onMemoryExtraction() {
    return this.hooks.onMemoryExtraction;
  }
  get onTTSSynthesis() {
    return this.hooks.onTTSSynthesis;
  }
  get onError() {
    return this.hooks.onError;
  }
};

// src/core/interaction-mode.ts
var InteractionModeManager = class {
  mode = { type: "main_agent" };
  queue = [];
  /** Returns the current interaction mode. */
  getMode() {
    return this.mode;
  }
  /** Shorthand: true when a subagent owns user transcript. */
  isSubagentActive() {
    return this.mode.type === "subagent_interaction";
  }
  /** Returns the active subagent's toolCallId, or null if in main_agent mode. */
  getActiveToolCallId() {
    return this.mode.type === "subagent_interaction" ? this.mode.toolCallId : null;
  }
  /**
   * Request interaction ownership for the given subagent.
   *
   * - If no subagent is currently active, activates immediately (returned Promise resolves).
   * - If another subagent is active, enqueues this one (FIFO). The returned Promise
   *   resolves when this subagent is promoted to the active interaction target.
   */
  activate(toolCallId, prompt) {
    if (this.mode.type === "main_agent") {
      this.mode = { type: "subagent_interaction", toolCallId, prompt };
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push({ toolCallId, prompt, resolve });
    });
  }
  /**
   * Release interaction ownership for the given subagent.
   *
   * If this subagent is the active one, promotes the next queued entry (if any)
   * or reverts to `main_agent` mode. If the subagent is queued (not active),
   * removes it from the queue.
   */
  deactivate(toolCallId) {
    if (this.mode.type === "subagent_interaction" && this.mode.toolCallId === toolCallId) {
      this.promoteNext();
      return;
    }
    const idx = this.queue.findIndex((q) => q.toolCallId === toolCallId);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
    }
  }
  /** Number of subagents waiting in the queue (excluding the active one). */
  get queueLength() {
    return this.queue.length;
  }
  promoteNext() {
    const next = this.queue.shift();
    if (next) {
      this.mode = {
        type: "subagent_interaction",
        toolCallId: next.toolCallId,
        prompt: next.prompt
      };
      next.resolve();
    } else {
      this.mode = { type: "main_agent" };
    }
  }
};

// src/core/memory-cache-manager.ts
var MemoryCacheManager = class {
  constructor(store, userId) {
    this.store = store;
    this.userId = userId;
  }
  store;
  userId;
  cache = [];
  /** Reload cached facts from the store. Best-effort: keeps stale cache on failure. */
  async refresh() {
    try {
      this.cache = await this.store.getAll(this.userId);
    } catch {
    }
  }
  /** Return the current cached facts. */
  get facts() {
    return this.cache;
  }
};

// src/core/session-manager.ts
var VALID_TRANSITIONS = {
  CREATED: ["CONNECTING", "CLOSED"],
  CONNECTING: ["ACTIVE", "CLOSED"],
  ACTIVE: ["RECONNECTING", "TRANSFERRING", "CLOSED"],
  RECONNECTING: ["ACTIVE", "CLOSED"],
  TRANSFERRING: ["ACTIVE", "CLOSED"],
  CLOSED: []
};
var SessionManager = class {
  constructor(config, eventBus, hooks) {
    this.eventBus = eventBus;
    this.hooks = hooks;
    this.sessionId = config.sessionId;
    this.userId = config.userId;
    this.initialAgent = config.initialAgent;
  }
  eventBus;
  hooks;
  _state = "CREATED";
  _resumptionHandle = null;
  _bufferedMessages = [];
  startedAt = null;
  sessionId;
  userId;
  initialAgent;
  get state() {
    return this._state;
  }
  get isActive() {
    return this._state === "ACTIVE";
  }
  get isDisconnected() {
    return this._state === "RECONNECTING" || this._state === "TRANSFERRING";
  }
  get resumptionHandle() {
    return this._resumptionHandle;
  }
  transitionTo(newState) {
    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed.includes(newState)) {
      throw new SessionError(`Invalid transition: ${this._state} \u2192 ${newState}`, {
        severity: "error"
      });
    }
    const fromState = this._state;
    this._state = newState;
    this.eventBus.publish("session.stateChange", {
      sessionId: this.sessionId,
      fromState,
      toState: newState
    });
    if (newState === "ACTIVE" && !this.startedAt) {
      this.startedAt = Date.now();
      if (this.hooks.onSessionStart) {
        this.hooks.onSessionStart({
          sessionId: this.sessionId,
          userId: this.userId,
          agentName: this.initialAgent
        });
      }
      this.eventBus.publish("session.start", {
        sessionId: this.sessionId,
        userId: this.userId,
        agentName: this.initialAgent
      });
    }
    if (newState === "CLOSED") {
      const durationMs = this.startedAt ? Date.now() - this.startedAt : 0;
      if (this.hooks.onSessionEnd) {
        this.hooks.onSessionEnd({
          sessionId: this.sessionId,
          durationMs,
          reason: fromState === "ACTIVE" ? "normal" : fromState
        });
      }
      this.eventBus.publish("session.close", {
        sessionId: this.sessionId,
        reason: fromState === "ACTIVE" ? "normal" : fromState
      });
    }
  }
  updateResumptionHandle(handle) {
    this._resumptionHandle = handle;
    this.eventBus.publish("session.resume", {
      sessionId: this.sessionId,
      handle
    });
  }
  bufferMessage(message) {
    this._bufferedMessages.push(message);
  }
  drainBufferedMessages() {
    const messages = this._bufferedMessages;
    this._bufferedMessages = [];
    return messages;
  }
};

// src/core/tool-call-router.ts
var ToolCallRouter = class {
  deps;
  constructor(deps) {
    this.deps = deps;
  }
  /** Update the tool executor (e.g. after an agent transfer). */
  set toolExecutor(executor) {
    this.deps.toolExecutor = executor;
  }
  /** Dispatch incoming tool calls to the appropriate handler. */
  handleToolCalls(calls) {
    const names = calls.map((c) => c.name).join(", ");
    this.deps.log(`Tool calls from LLM: [${names}]`);
    this.deps.transcriptManager.flushInput();
    this.deps.transcriptManager.saveOutputPrefix();
    for (const call of calls) {
      const toolCall = {
        toolCallId: call.id,
        toolName: call.name,
        args: call.args
      };
      if (call.name === "transfer_to_agent" && call.args.agent_name) {
        this.deps.transfer(call.args.agent_name).catch((err) => {
          this.deps.reportError("agent-router", err);
        });
        this.deps.sendToolResult({
          id: call.id,
          name: call.name,
          result: { status: "transferred" },
          scheduling: "immediate"
        });
        return;
      }
      const agent = this.deps.agentRouter.activeAgent;
      const toolDef = agent.tools.find((t) => t.name === call.name);
      if (toolDef?.execution === "background") {
        this.handleBackgroundToolCall(toolCall, toolDef);
      } else {
        this.handleInlineToolCall(toolCall);
      }
    }
  }
  /** Abort one or more pending tool executions and subagents. */
  handleToolCallCancellation(ids) {
    this.deps.toolExecutor.cancel(ids);
    for (const id of ids) {
      this.deps.agentRouter.cancelSubagent(id);
    }
  }
  handleInlineToolCall(call) {
    this.deps.toolExecutor.handleToolCall(call).then((result) => {
      this.deps.conversationContext.addToolCall(call);
      this.deps.conversationContext.addToolResult(result);
      this.deps.sendToolResult({
        id: result.toolCallId,
        name: result.toolName,
        result: result.error ? { error: result.error } : result.result,
        scheduling: "immediate"
      });
    }).catch((err) => {
      this.deps.reportError("tool-executor", err);
      this.deps.sendToolResult({
        id: call.toolCallId,
        name: call.toolName,
        result: { error: err instanceof Error ? err.message : String(err) },
        scheduling: "immediate"
      });
    });
  }
  handleBackgroundToolCall(call, toolDef) {
    const hasPendingMessage = !!toolDef.pendingMessage;
    if (hasPendingMessage) {
      this.deps.sendToolResult({
        id: call.toolCallId,
        name: call.toolName,
        result: {
          status: "still_in_progress",
          message: toolDef.pendingMessage,
          important: "This task is NOT complete yet. Do NOT tell the user it is ready. You will receive a notification when it finishes."
        },
        scheduling: "immediate"
      });
    }
    const registeredConfig = this.deps.subagentConfigs[call.toolName];
    if (!registeredConfig) {
      this.handleInlineToolCall(call);
      return;
    }
    const subagentConfig = registeredConfig.createInstance ? registeredConfig.createInstance() : registeredConfig;
    this.deps.conversationContext.addToolCall(call);
    this.deps.agentRouter.handoff(call, subagentConfig).then((result) => {
      this.deps.conversationContext.addToolResult({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: result.text
      });
      if (hasPendingMessage) {
        this.deps.notificationQueue.sendOrQueue(
          [
            {
              role: "user",
              parts: [
                {
                  text: `[SYSTEM: Background task "${call.toolName}" completed successfully. Result: ${result.text}. Please inform the user their content is ready now.]`
                }
              ]
            }
          ],
          true
        );
      } else {
        this.deps.sendToolResult({
          id: call.toolCallId,
          name: call.toolName,
          result: { result: result.text },
          scheduling: "when_idle"
        });
      }
    }).catch((err) => {
      this.deps.reportError("subagent-runner", err);
      this.deps.conversationContext.addToolResult({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: null,
        error: err instanceof Error ? err.message : String(err)
      });
      if (hasPendingMessage) {
        this.deps.notificationQueue.sendOrQueue(
          [
            {
              role: "user",
              parts: [
                {
                  text: `[SYSTEM: Background task "${call.toolName}" failed. Exact error details: ${err instanceof Error ? err.message : String(err)}. Tell the user the exact error details first, then ask how to proceed.]`
                }
              ]
            }
          ],
          true
        );
      } else {
        this.deps.sendToolResult({
          id: call.toolCallId,
          name: call.toolName,
          result: { error: err instanceof Error ? err.message : String(err) },
          scheduling: "when_idle"
        });
      }
    });
  }
};

// src/core/transcript-manager.ts
var TranscriptManager = class {
  constructor(sink) {
    this.sink = sink;
  }
  sink;
  inputBuffer = "";
  outputBuffer = "";
  /** Pre-tool-call output text, saved when a tool call splits a turn. */
  outputPrefix = "";
  /**
   * Optional callback fired when user input is finalized (committed as a non-partial message).
   * Triggers from both `flushInput()` and the input-flushing section of `flush()`.
   * Used by VoiceSession to relay finalized user text to interactive subagent sessions.
   */
  onInputFinalized;
  /** Handle a partial/interim transcript from a streaming STT provider.
   *  Sends to client for live display but does NOT accumulate in inputBuffer.
   *  The streaming provider manages its own partial state — each partial
   *  replaces the previous one on the client. */
  handleInputPartial(text) {
    if (text.trim()) {
      this.sink.sendToClient({
        type: "transcript",
        role: "user",
        text: text.trim(),
        partial: true
      });
    }
  }
  /**
   * Replace the current input buffer with an authoritative transcript
   * (e.g. from Gemini's built-in inputAudioTranscription).
   * Sends a corrected partial to the client so the UI updates.
   * No-op if the correction is empty.
   */
  correctInput(text) {
    if (!text.trim()) return;
    this.inputBuffer = text;
    this.sink.sendToClient({
      type: "transcript",
      role: "user",
      text: text.trim(),
      partial: true,
      corrected: true
    });
  }
  /** Accumulate incoming user speech transcription and emit a partial transcript. */
  handleInput(text) {
    if (text.trim()) {
      this.inputBuffer += text;
      this.sink.sendToClient({
        type: "transcript",
        role: "user",
        text: this.inputBuffer.trim(),
        partial: true
      });
    }
  }
  /** Accumulate incoming model speech transcription and emit a partial transcript. */
  handleOutput(text) {
    if (text.trim()) {
      this.outputBuffer += text;
      const combined = this.combineOutput();
      this.sink.sendToClient({
        type: "transcript",
        role: "assistant",
        text: combined,
        partial: true
      });
    }
  }
  /**
   * Save current output buffer as prefix and reset buffer.
   * Called before tool execution so post-tool transcription can be deduplicated.
   */
  saveOutputPrefix() {
    if (this.outputBuffer.trim()) {
      this.outputPrefix += this.outputBuffer;
      this.outputBuffer = "";
    }
  }
  /**
   * Flush only the input transcript buffer — finalize as a user message and
   * send a non-partial transcript to the client. Used before tool calls so
   * the user utterance appears in context before tool results.
   */
  flushInput() {
    if (this.inputBuffer.trim()) {
      const text = this.inputBuffer.trim();
      this.sink.addUserMessage(text);
      this.sink.sendToClient({
        type: "transcript",
        role: "user",
        text,
        partial: false
      });
      this.inputBuffer = "";
      this.onInputFinalized?.(text);
    }
  }
  /** Flush all transcript buffers — finalize user and assistant messages. */
  flush() {
    if (this.inputBuffer.trim()) {
      const text = this.inputBuffer.trim();
      this.sink.addUserMessage(text);
      this.sink.sendToClient({
        type: "transcript",
        role: "user",
        text,
        partial: false
      });
      this.onInputFinalized?.(text);
    }
    const outputText = this.combineOutput();
    if (outputText) {
      this.sink.addAssistantMessage(outputText);
      this.sink.sendToClient({
        type: "transcript",
        role: "assistant",
        text: outputText,
        partial: false
      });
    }
    this.inputBuffer = "";
    this.outputBuffer = "";
    this.outputPrefix = "";
  }
  /**
   * Combine pre-tool prefix and post-tool buffer, deduplicating any overlap.
   *
   * Gemini's outputTranscription can "leak" post-tool text into the pre-tool
   * stream, then re-send it after the tool result. This finds the longest
   * suffix of prefix that matches a prefix of buffer and removes the overlap.
   */
  combineOutput() {
    const prefix = this.outputPrefix.trim();
    const buffer = this.outputBuffer.trim();
    if (!prefix) return buffer;
    if (!buffer) return prefix;
    if (prefix.endsWith(buffer)) return prefix;
    const maxOverlap = Math.min(prefix.length, buffer.length);
    let overlap = 0;
    for (let i = 1; i <= maxOverlap; i++) {
      if (prefix.slice(-i) === buffer.slice(0, i)) {
        overlap = i;
      }
    }
    if (overlap > 0) {
      return prefix + buffer.slice(overlap);
    }
    return `${prefix} ${buffer}`;
  }
};

// src/core/voice-session.ts
var VoiceSession = class _VoiceSession {
  eventBus;
  sessionManager;
  conversationContext;
  hooks;
  transport;
  clientTransport;
  agentRouter;
  toolExecutor;
  toolCallRouter;
  subagentConfigs;
  behaviorManager;
  memoryDistiller;
  memoryCacheManager;
  turnId = 0;
  sttProvider;
  _commitFiredForTurn = false;
  /** True when the current turn was interrupted — skips Gemini transcript correction. */
  _turnWasInterrupted = false;
  // --- TTS state ---
  ttsProvider;
  _ttsCurrentRequestId = 0;
  _ttsTurnHasText = false;
  _ttsLlmTextDone = false;
  _ttsAudioDone = false;
  _ttsSpeaking = false;
  _ttsFormat;
  _ttsIdleTimer;
  _ttsHardTimer;
  _ttsFirstTextMs = 0;
  _ttsFirstAudioMs = 0;
  _ttsTextLength = 0;
  config;
  directiveManager = new DirectiveManager();
  transcriptManager;
  /** Whether a client WebSocket connection is currently active. */
  clientConnected = false;
  notificationQueue;
  interactionMode = new InteractionModeManager();
  /** Tracks consecutive reconnect attempts to prevent infinite reconnect storms. */
  reconnectAttempts = 0;
  static MAX_RECONNECT_ATTEMPTS = 3;
  static RECONNECT_BACKOFF_MS = [1e3, 2e3, 4e3];
  /** Resolves when memory/directives are loaded; used so greeting is sent after load without blocking connect. */
  _memoryReadyPromise = Promise.resolve();
  externalAudioHandler = null;
  constructor(config) {
    this.config = config;
    this.eventBus = new EventBus();
    this.hooks = new HooksManager();
    this.conversationContext = new ConversationContext();
    this.transcriptManager = new TranscriptManager({
      sendToClient: (msg) => this.clientTransport.sendJsonToClient(msg),
      addUserMessage: (text) => this.conversationContext.addUserMessage(text),
      addAssistantMessage: (text) => this.conversationContext.addAssistantMessage(text)
    });
    this.transcriptManager.onInputFinalized = (text) => {
      const activeId = this.interactionMode.getActiveToolCallId();
      if (activeId) {
        const session = this.agentRouter.getSubagentSession(activeId);
        if (session && session.state === "waiting_for_input") {
          session.sendToSubagent(text);
          this.interactionMode.deactivate(activeId);
        }
      }
    };
    this.notificationQueue = new BackgroundNotificationQueue(
      (turns, turnComplete) => {
        const contentTurns = turns.map((t) => ({
          role: t.role === "model" ? "assistant" : t.role,
          text: t.parts[0]?.text ?? ""
        }));
        this.transport.sendContent(contentTurns, turnComplete);
      },
      (msg) => this.log(msg),
      config.transport?.capabilities?.messageTruncation ?? false
    );
    if (config.hooks) {
      this.hooks.register(config.hooks);
    }
    this.sessionManager = new SessionManager(
      {
        sessionId: config.sessionId,
        userId: config.userId,
        initialAgent: config.initialAgent
      },
      this.eventBus,
      this.hooks
    );
    this.subagentConfigs = config.subagentConfigs ?? {};
    if (config.behaviors?.length) {
      const memoryStore = config.memory?.store;
      const onPresetChange = memoryStore ? () => {
        const presets = Object.fromEntries(this.behaviorManager?.activePresets ?? []);
        memoryStore.setDirectives(config.userId, presets).catch(() => {
        });
      } : void 0;
      this.behaviorManager = new BehaviorManager(
        config.behaviors,
        (key, value, scope) => this.directiveManager.set(key, value, scope),
        (msg) => this.clientTransport.sendJsonToClient(msg),
        onPresetChange
      );
    }
    if (config.memory) {
      this.memoryCacheManager = new MemoryCacheManager(config.memory.store, config.userId);
      const freq = config.memory.turnFrequency ?? 5;
      this.memoryDistiller = new MemoryDistiller(
        this.conversationContext,
        config.memory.store,
        this.hooks,
        config.model,
        {
          userId: config.userId,
          sessionId: config.sessionId,
          turnFrequency: freq
        }
      );
      this.log(`Memory distillation enabled (every ${freq} turns)`);
    }
    if (config.conversationHistoryStore) {
      new ConversationHistoryWriter(
        config.sessionId,
        config.userId,
        config.initialAgent,
        this.eventBus,
        this.conversationContext,
        config.conversationHistoryStore
      );
    }
    const initialAgent = config.agents.find((a) => a.name === config.initialAgent);
    const instructions = initialAgent ? resolveInstructions(initialAgent) : "";
    const behaviorTools = this.behaviorManager?.tools ?? [];
    const allInitialTools = [...initialAgent?.tools ?? [], ...behaviorTools];
    const inputTranscription = config.inputAudioTranscription;
    if (config.transport) {
      this.transport = config.transport;
      this.transport.updateSession({
        instructions,
        tools: allInitialTools.length ? allInitialTools : void 0,
        ...inputTranscription === false && {
          transcription: { input: false }
        }
      });
    } else {
      this.transport = new GeminiLiveTransport(
        {
          apiKey: config.apiKey,
          model: config.geminiModel,
          systemInstruction: instructions,
          tools: allInitialTools.length ? allInitialTools : void 0,
          googleSearch: initialAgent?.googleSearch,
          speechConfig: config.speechConfig,
          compressionConfig: config.compressionConfig,
          inputAudioTranscription: inputTranscription
        },
        {}
      );
    }
    this.transport.onAudioOutput = (data) => this.handleAudioOutput(data);
    this.transport.onToolCall = (calls) => this.toolCallRouter?.handleToolCalls(calls);
    this.transport.onToolCallCancel = (ids) => this.toolCallRouter?.handleToolCallCancellation(ids);
    this.transport.onTurnComplete = () => this.handleTurnComplete();
    this.transport.onInterrupted = () => this.handleInterrupted();
    this.transport.onOutputTranscription = (text) => this.transcriptManager.handleOutput(text);
    this.transport.onSessionReady = (sessionId) => this.handleSetupComplete(sessionId);
    this.transport.onError = (error) => this.handleTransportError(error);
    this.transport.onClose = (code, reason) => this.handleTransportClose(code, reason);
    this.transport.onGoAway = (timeLeft) => this.handleGoAway(timeLeft);
    this.transport.onResumptionUpdate = (handle, resumable) => this.handleResumptionUpdate(handle, resumable);
    this.transport.onGroundingMetadata = (metadata) => this.handleGroundingMetadata(metadata);
    if (config.sttProvider) {
      this.sttProvider = config.sttProvider;
      this.sttProvider.configure({
        sampleRate: this.transport.audioFormat.inputSampleRate,
        bitDepth: this.transport.audioFormat.bitDepth,
        channels: this.transport.audioFormat.channels
      });
      this.sttProvider.onTranscript = (text, turnId) => {
        if (turnId !== void 0 && turnId < this.turnId - 1) return;
        this.transcriptManager.handleInput(text);
      };
      this.sttProvider.onPartialTranscript = (text) => {
        this.transcriptManager.handleInputPartial(text);
      };
      this.transport.onInputTranscription = (text) => {
        if (this._turnWasInterrupted) return;
        this.transcriptManager.correctInput(text);
      };
    } else {
      this.transport.onInputTranscription = (text) => this.transcriptManager.handleInput(text);
    }
    this.transport.onModelTurnStart = () => {
      if (this.sttProvider && !this._commitFiredForTurn) {
        this._commitFiredForTurn = true;
        this.sttProvider.commit(this.turnId);
      }
    };
    if (config.ttsProvider) {
      this.ttsProvider = config.ttsProvider;
      this.wireTtsProvider();
    }
    if (config.clientSender) {
      this.clientTransport = new ClientSenderAdapter(config.clientSender);
    } else {
      this.clientTransport = new ClientTransport(
        config.port ?? 9900,
        {
          onAudioFromClient: (data) => this.handleAudioFromClient(data),
          onJsonFromClient: (message) => this.handleJsonFromClient(message),
          onClientConnected: () => this.handleClientConnected(),
          onClientDisconnected: () => this.handleClientDisconnected()
        },
        config.host ?? "0.0.0.0",
        config.listenTimeoutMs ?? 1e4
      );
    }
    this.eventBus.subscribe("gui.update", (payload) => {
      this.clientTransport.sendJsonToClient({ type: "gui.update", payload });
    });
    this.eventBus.subscribe("gui.notification", (payload) => {
      this.clientTransport.sendJsonToClient({ type: "gui.notification", payload });
    });
    this.eventBus.subscribe("subagent.ui.send", (payload) => {
      this.clientTransport.sendJsonToClient({ type: "ui.payload", payload: payload.payload });
    });
    this.eventBus.subscribe("session.stateChange", (payload) => {
      if (payload.toState === "ACTIVE") {
        this.startSttProvider();
      } else if (payload.toState === "RECONNECTING" || payload.toState === "TRANSFERRING") {
        void this.sttProvider?.stop();
      }
    });
    this.eventBus.subscribe(
      "subagent.ui.response",
      (payload) => {
        const { requestId, selectedOptionId } = payload.response;
        if (!requestId || !selectedOptionId) return;
        const session = this.agentRouter.findSessionByRequestId(requestId);
        if (!session) return;
        const option = session.resolveOption(requestId, selectedOptionId);
        const answerText = option?.label ?? selectedOptionId;
        session.trySendToSubagent(answerText);
      }
    );
    this.eventBus.subscribe("agent.transfer_requested", (payload) => {
      setImmediate(() => {
        this.agentRouter.transfer(payload.toAgent).catch((err) => {
          this.log(
            `Transfer requested to "${payload.toAgent}" failed: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      });
    });
    this.toolExecutor = this.createToolExecutor(config.initialAgent);
    if (allInitialTools.length) {
      this.toolExecutor.register(allInitialTools);
    }
    this.agentRouter = new AgentRouter(
      this.sessionManager,
      this.eventBus,
      this.hooks,
      this.conversationContext,
      this.transport,
      this.clientTransport,
      config.model,
      () => this.directiveManager.getSessionSuffix(),
      behaviorTools,
      {
        onMessage: (toolCallId, msg) => this.handleSubagentMessage(toolCallId, msg),
        onSessionEnd: (toolCallId) => this.interactionMode.deactivate(toolCallId)
      },
      {
        setExternalAudioHandler: (handler) => {
          this.externalAudioHandler = handler;
        },
        sendAudioToClient: (data) => {
          this.clientTransport.sendAudioToClient(data);
        }
      }
    );
    this.agentRouter.registerAgents(config.agents);
    this.agentRouter.setInitialAgent(config.initialAgent);
    if (this.ttsProvider) {
      this.agentRouter.responseModality = "text";
    }
    this.transport.onRealtimeLLMUsage = (usage) => {
      if (this.hooks.onRealtimeLLMUsage) {
        this.hooks.onRealtimeLLMUsage({
          sessionId: this.config.sessionId,
          agentName: this.agentRouter.activeAgent.name,
          usage
        });
      }
    };
    this.toolCallRouter = new ToolCallRouter({
      toolExecutor: this.toolExecutor,
      agentRouter: this.agentRouter,
      conversationContext: this.conversationContext,
      notificationQueue: this.notificationQueue,
      transcriptManager: this.transcriptManager,
      subagentConfigs: this.subagentConfigs,
      sendToolResult: (result) => this.transport.sendToolResult(result),
      transfer: (toAgent) => this.transfer(toAgent),
      reportError: (component, error) => this.reportError(component, error),
      log: (msg) => this.log(msg)
    });
  }
  /**
   * Queue a short spoken update for the user.
   * Delivered immediately when possible, otherwise after the current turn.
   */
  notifyBackground(text, options) {
    const label = options?.label ?? "SUBAGENT UPDATE";
    this.notificationQueue.sendOrQueue(
      [{ role: "user", parts: [{ text: `[${label}]: ${text}` }] }],
      true,
      { priority: options?.priority ?? "normal" }
    );
  }
  /** Start the client WebSocket server and connect to the LLM transport. */
  async start() {
    if (this.ttsProvider) {
      if (!this.transport.capabilities.textResponseModality) {
        throw new Error(
          "TTSProvider requires text-mode responses, but the transport does not support textResponseModality"
        );
      }
    }
    await this.sttProvider?.start();
    await this.ttsProvider?.start();
    this._memoryReadyPromise = this.loadMemoryAndDirectives();
    await this.clientTransport.start();
    this.log("Connecting to LLM transport...");
    this.sessionManager.transitionTo("CONNECTING");
    if (this.config.transport) {
      if (this.ttsProvider) {
        this.transport.updateSession({ responseModality: "text" });
      }
      await this.transport.connect();
    } else {
      await this.transport.connect({
        auth: { type: "api_key", apiKey: this.config.apiKey },
        model: this.config.geminiModel ?? "gemini-live-2.5-flash-preview",
        ...this.ttsProvider ? { responseModality: "text" } : {}
      });
    }
    this.log("LLM transport connected and setup complete");
  }
  /** Load memory cache and restore behavior directives; used in parallel with connect(). */
  async loadMemoryAndDirectives() {
    await this.memoryCacheManager?.refresh();
    if (this.config.memory && this.behaviorManager) {
      try {
        const directives = await this.config.memory.store.getDirectives(this.config.userId);
        const restored = [];
        for (const [key, presetName] of Object.entries(directives)) {
          if (this.behaviorManager.restorePreset(key, presetName)) {
            restored.push(key);
          }
        }
        if (restored.length > 0) {
          this.log(`Restored behavior presets from directives: ${restored.join(", ")}`);
        }
      } catch {
      }
    }
  }
  /**
   * Workspace API for persisting artifacts (images, videos, docs, etc.) produced by agents/tools.
   * When no artifactStore is configured, saveArtifact returns null without persisting.
   */
  get workspace() {
    const sessionId = this.config.sessionId;
    const userId = this.config.userId;
    const store = this.config.artifactStore;
    return {
      async saveArtifact(params) {
        if (!store) return null;
        const full = {
          ...params,
          sessionId: params.sessionId ?? sessionId,
          userId: params.userId ?? userId
        };
        return store.saveArtifact(full);
      }
    };
  }
  /** Gracefully shut down: disconnect Gemini, stop the WebSocket server, transition to CLOSED. */
  async close(_reason = "normal") {
    this.notificationQueue.clear();
    this.transcriptManager.flush();
    if (this.turnId > 0) {
      this.eventBus.publish("turn.end", {
        sessionId: this.config.sessionId,
        turnId: `turn_${this.turnId}`
      });
    }
    if (this.memoryDistiller) {
      this.log("Running final memory extraction...");
      try {
        await this.memoryDistiller.forceExtract();
        this.log("Final memory extraction complete");
      } catch {
        this.log("Final memory extraction failed (best-effort)");
      }
    }
    await this.sttProvider?.stop();
    this.ttsClearTimers();
    await this.ttsProvider?.stop();
    this.config.artifactRegistry?.dispose();
    await this.transport.disconnect();
    await this.clientTransport.stop();
    if (this.sessionManager.state !== "CLOSED") {
      this.sessionManager.transitionTo("CLOSED");
    }
    this.eventBus.clear();
  }
  /** Transfer the active session to a different agent (reconnects with new config). */
  async transfer(toAgent) {
    this.log(`Transferring to agent "${toAgent}"...`);
    await this.agentRouter.transfer(toAgent);
    this.log(`Transfer to "${toAgent}" complete`);
    const agent = this.agentRouter.activeAgent;
    this.toolExecutor = this.createToolExecutor(agent.name);
    const behaviorTools = this.behaviorManager?.tools ?? [];
    this.toolExecutor.register([...agent.tools, ...behaviorTools]);
    if (this.toolCallRouter) {
      this.toolCallRouter.toolExecutor = this.toolExecutor;
    }
    this.directiveManager.clearAgent();
    if (this.clientConnected) {
      this.sendGreeting();
    }
  }
  createToolExecutor(agentName) {
    return new ToolExecutor(
      this.hooks,
      this.eventBus,
      this.config.sessionId,
      agentName,
      (msg) => this.clientTransport.sendJsonToClient(msg),
      (key, value, scope) => this.directiveManager.set(key, value, scope)
    );
  }
  createAgentContext(agentName) {
    return {
      sessionId: this.config.sessionId,
      agentName,
      injectSystemMessage: (text) => this.conversationContext.addAssistantMessage(`[system] ${text}`),
      getRecentTurns: (count = 10) => [...this.conversationContext.items].slice(-count),
      getMemoryFacts: () => this.memoryCacheManager?.facts ?? [],
      requestTransfer: (toAgent) => {
        setImmediate(() => {
          this.eventBus.publish("agent.transfer_requested", {
            sessionId: this.config.sessionId,
            toAgent
          });
        });
      },
      stopBufferingAndDrain: (handler) => {
        const buffered = this.clientTransport.stopBuffering();
        for (const chunk of buffered) {
          handler(chunk);
        }
      },
      sendJsonToClient: (message) => {
        this.clientTransport.sendJsonToClient(message);
      },
      sendAudioToClient: (data) => {
        this.clientTransport.sendAudioToClient(data);
      },
      setExternalAudioHandler: (handler) => {
        this.externalAudioHandler = handler;
      }
    };
  }
  // --- Audio fast-path (no EventBus) ---
  handleAudioFromClient(data) {
    if (this.sessionManager.isActive) {
      if (this.agentRouter.activeAgent.audioMode === "external") {
        if (this.externalAudioHandler) {
          try {
            this.externalAudioHandler(data);
          } catch (err) {
            this.reportError("external-audio", err instanceof Error ? err : new Error(String(err)));
          }
        }
        return;
      }
      const base64 = data.toString("base64");
      this.transport.sendAudio(base64);
      this.sttProvider?.feedAudio(base64);
    }
  }
  handleAudioOutput(data) {
    this.notificationQueue.markAudioReceived();
    const buffer = Buffer.from(data, "base64");
    this.clientTransport.sendAudioToClient(buffer);
  }
  // --- TTS wiring ---
  /** Wire TTSProvider callbacks and override transport callbacks for text mode. */
  wireTtsProvider() {
    const tts = this.ttsProvider;
    if (!tts) return;
    const preferredFormat = {
      sampleRate: this.transport.audioFormat.outputSampleRate,
      bitDepth: 16,
      channels: 1,
      encoding: "pcm"
    };
    this._ttsFormat = tts.configure(preferredFormat);
    this.transport.onTextOutput = (text) => {
      this.transcriptManager.handleOutput(text);
      if (!text || text.trim().length === 0) {
        return;
      }
      if (!this._ttsTurnHasText) {
        this._ttsCurrentRequestId++;
        this._ttsTurnHasText = true;
        this._ttsFirstTextMs = Date.now();
        this._ttsFirstAudioMs = 0;
        this._ttsTextLength = 0;
      }
      this._ttsTextLength += text.length;
      tts.synthesize(text, this._ttsCurrentRequestId);
    };
    this.transport.onTextDone = () => {
      if (this._ttsTurnHasText) {
        tts.synthesize("", this._ttsCurrentRequestId, { flush: true });
      }
    };
    tts.onAudio = (base64Pcm, _durationMs, requestId) => {
      if (requestId !== this._ttsCurrentRequestId) return;
      let buffer = Buffer.from(base64Pcm, "base64");
      if (this._ttsFormat && this._ttsFormat.sampleRate !== this.transport.audioFormat.outputSampleRate) {
        buffer = resamplePcm(
          buffer,
          this._ttsFormat.sampleRate,
          this.transport.audioFormat.outputSampleRate,
          this._ttsFormat.bitDepth
        );
      }
      this.clientTransport.sendAudioToClient(buffer);
      this.notificationQueue.markAudioReceived();
      this._ttsSpeaking = true;
      if (this._ttsFirstAudioMs === 0) {
        this._ttsFirstAudioMs = Date.now();
      }
      this.ttsResetIdleTimer();
    };
    tts.onDone = (requestId) => {
      if (requestId !== this._ttsCurrentRequestId) return;
      this._ttsAudioDone = true;
      this._ttsSpeaking = false;
      this.ttsClearTimers();
      if (this.hooks.onTTSSynthesis && this._ttsFirstTextMs > 0) {
        const now = Date.now();
        this.hooks.onTTSSynthesis({
          sessionId: this.config.sessionId,
          provider: tts.constructor.name,
          textLength: this._ttsTextLength,
          durationMs: now - this._ttsFirstTextMs,
          audioMs: 0,
          // Would require tracking total audio duration
          ttfbMs: this._ttsFirstAudioMs > 0 ? this._ttsFirstAudioMs - this._ttsFirstTextMs : 0,
          requestId
        });
      }
      this.ttsMaybeCompleteTurn();
    };
    tts.onError = (error, fatal) => {
      this.log(`TTS error (fatal=${fatal}): ${error.message}`);
      if (this.hooks.onError) {
        this.hooks.onError({
          component: "tts",
          error,
          severity: fatal ? "fatal" : "warn"
        });
      }
      if (fatal) {
        this.close("tts_fatal_error");
      }
    };
    tts.onWordBoundary = (word, offsetMs, requestId) => {
      if (requestId !== this._ttsCurrentRequestId) return;
      this.clientTransport.sendJsonToClient({
        type: "word_boundary",
        word,
        offsetMs,
        requestId
      });
    };
    this.transport.onSpeechStarted = () => {
      if (this._ttsSpeaking && this._ttsLlmTextDone) {
        this.handleInterrupted();
      }
    };
    this.transport.onAudioOutput = void 0;
    this.transport.onOutputTranscription = void 0;
  }
  /** Turn gating: check if both LLM and TTS are done. */
  ttsMaybeCompleteTurn() {
    if (this._ttsLlmTextDone && this._ttsAudioDone) {
      this._ttsLlmTextDone = false;
      this._ttsAudioDone = false;
      this._ttsTurnHasText = false;
      this.ttsClearTimers();
      this.handleTurnCompleteInternal();
    }
  }
  /** Reset the idle watchdog timer (called on each TTS audio chunk). */
  ttsResetIdleTimer() {
    if (this._ttsIdleTimer) clearTimeout(this._ttsIdleTimer);
    this._ttsIdleTimer = setTimeout(() => {
      this.log("TTS idle watchdog fired \u2014 forcing turn completion");
      this._ttsAudioDone = true;
      this._ttsSpeaking = false;
      this._ttsCurrentRequestId++;
      this.ttsMaybeCompleteTurn();
    }, 2e3);
  }
  /** Clear all TTS timers. */
  ttsClearTimers() {
    if (this._ttsIdleTimer) {
      clearTimeout(this._ttsIdleTimer);
      this._ttsIdleTimer = void 0;
    }
    if (this._ttsHardTimer) {
      clearTimeout(this._ttsHardTimer);
      this._ttsHardTimer = void 0;
    }
  }
  // --- Gemini event handlers ---
  handleSetupComplete(_sessionId) {
    this.log(`Gemini setup complete (clientConnected=${this.clientConnected})`);
    if (this.sessionManager.state === "CONNECTING") {
      this.sessionManager.transitionTo("ACTIVE");
    }
    if (this.sessionManager.state === "TRANSFERRING" || this.sessionManager.state === "RECONNECTING") {
      return;
    }
    if (this.clientConnected) {
      this._memoryReadyPromise.then(() => this.sendGreeting());
    }
  }
  /** Start STT when session becomes ACTIVE (agent ready). Fire-and-forget. */
  startSttProvider() {
    if (!this.sttProvider) return;
    this.sttProvider.start().catch((err) => this.reportError("stt", err));
  }
  handleTurnComplete() {
    this.reconnectAttempts = 0;
    if (this.ttsProvider) {
      this._ttsLlmTextDone = true;
      if (!this._ttsTurnHasText) {
        this._ttsAudioDone = true;
      } else {
        if (!this._ttsHardTimer) {
          this._ttsHardTimer = setTimeout(() => {
            this.log("TTS hard cap timer fired \u2014 forcing turn completion");
            this._ttsAudioDone = true;
            this._ttsSpeaking = false;
            this._ttsCurrentRequestId++;
            this.ttsMaybeCompleteTurn();
          }, 6e4);
        }
      }
      this.ttsMaybeCompleteTurn();
      return;
    }
    this.handleTurnCompleteInternal();
  }
  /** Core turn-end logic — called directly (no TTS) or via ttsMaybeCompleteTurn (TTS gate). */
  handleTurnCompleteInternal() {
    if (this.sttProvider) {
      if (!this._commitFiredForTurn) {
        this.sttProvider.commit(this.turnId);
      }
      this.sttProvider.handleTurnComplete();
      this._commitFiredForTurn = false;
      this._turnWasInterrupted = false;
    }
    this.transcriptManager.flush();
    this.turnId++;
    const turnIdStr = `turn_${this.turnId}`;
    this.log(`Turn complete: ${turnIdStr}`);
    this.eventBus.publish("turn.end", {
      sessionId: this.config.sessionId,
      turnId: turnIdStr
    });
    this.clientTransport.sendJsonToClient({ type: "turn.end", turnId: turnIdStr });
    const agent = this.agentRouter.activeAgent;
    if (agent.onTurnCompleted) {
      const transcript = this.conversationContext.items.slice(-5).map((i) => `[${i.role}]: ${i.content}`).join("\n");
      agent.onTurnCompleted(this.createAgentContext(agent.name), transcript);
    }
    if (this.memoryDistiller) {
      this.memoryDistiller.onTurnEnd();
      this.memoryCacheManager?.refresh();
    }
    this.reinforceDirectives();
    this.notificationQueue.onTurnComplete();
  }
  /** Inject all active directives into the LLM's context to prevent behavioral drift. */
  reinforceDirectives() {
    const text = this.directiveManager.getReinforcementText();
    if (!text) return;
    this.log(`Reinforcing directives: ${text.slice(0, 120)}...`);
    this.transport.sendContent([{ role: "user", text }], true);
  }
  /** Send the active agent's greeting prompt to the LLM to trigger a spoken greeting. */
  sendGreeting() {
    const agent = this.agentRouter.activeAgent;
    if (!agent.greeting) return;
    this.log(`Sending greeting for agent "${agent.name}"`);
    this.notificationQueue.resetAudio();
    const cachedFacts = this.memoryCacheManager?.facts ?? [];
    if (cachedFacts.length > 0) {
      const summary = cachedFacts.map((f) => `- ${f.content}`).join("\n");
      const memoryText = `[MEMORY \u2014 what you already know about this user from previous sessions]
${summary}`;
      this.transport.sendContent([{ role: "user", text: memoryText }], true);
      this.log(`Injected ${cachedFacts.length} memory facts`);
    }
    const directiveSuffix = this.directiveManager.getSessionSuffix();
    const greetingText = directiveSuffix ? `${directiveSuffix}

${agent.greeting}` : agent.greeting;
    this.transport.sendContent([{ role: "user", text: greetingText }], true);
  }
  handleInterrupted() {
    this.log("Interrupted by user");
    this._turnWasInterrupted = true;
    this.sttProvider?.handleInterrupted();
    if (this.ttsProvider) {
      this.ttsProvider.cancel();
      this._ttsSpeaking = false;
      this._ttsLlmTextDone = false;
      this._ttsAudioDone = false;
      this._ttsTurnHasText = false;
      this._ttsCurrentRequestId++;
      this.ttsClearTimers();
    }
    this.notificationQueue.resetAudio();
    this.notificationQueue.markInterrupted();
    this.transcriptManager.flush();
    this.eventBus.publish("turn.interrupted", {
      sessionId: this.config.sessionId,
      turnId: `turn_${this.turnId}`
    });
    this.clientTransport.sendJsonToClient({ type: "turn.interrupted" });
  }
  /** Handle a message from an interactive subagent (question, progress update). */
  handleSubagentMessage(toolCallId, msg) {
    if (msg.type === "result") return;
    if (msg.blocking) {
      this.interactionMode.activate(toolCallId);
    }
    const label = msg.type === "question" ? "SUBAGENT QUESTION" : "SUBAGENT UPDATE";
    this.notificationQueue.sendOrQueue(
      [{ role: "user", parts: [{ text: `[${label}]: ${msg.text}` }] }],
      true,
      { priority: msg.blocking ? "high" : "normal" }
    );
  }
  handleGroundingMetadata(metadata) {
    this.clientTransport.sendJsonToClient({ type: "grounding", payload: metadata });
  }
  handleGoAway(timeLeft) {
    this.log(`GoAway from Gemini (timeLeft=${timeLeft})`);
    this.eventBus.publish("session.goaway", {
      sessionId: this.config.sessionId,
      timeLeft
    });
    const handle = this.sessionManager.resumptionHandle;
    if (handle) {
      this.sessionManager.transitionTo("RECONNECTING");
      this.clientTransport.startBuffering();
      this.transport.reconnect({ conversationHistory: this.conversationContext.toReplayContent() }).then(() => {
        const buffered = this.clientTransport.stopBuffering();
        for (const chunk of buffered) {
          this.transport.sendAudio(chunk.toString("base64"));
        }
        this.sessionManager.transitionTo("ACTIVE");
      }).catch((err) => {
        this.clientTransport.stopBuffering();
        this.reportError("reconnect", err);
        this.sessionManager.transitionTo("CLOSED");
      });
    }
  }
  handleResumptionUpdate(handle, _resumable) {
    this.sessionManager.updateResumptionHandle(handle);
  }
  // --- Client transport handlers ---
  handleJsonFromClient(message) {
    if (message.type === "behavior.set" && typeof message.key === "string" && typeof message.preset === "string") {
      this.behaviorManager?.handleClientSet(message.key, message.preset);
    } else if (message.type === "ui.response" && message.payload) {
      this.eventBus.publish("subagent.ui.response", {
        sessionId: this.config.sessionId,
        response: message.payload
      });
    } else if (message.type === "file_upload" && message.data) {
      const data = message.data;
      this.handleFileUpload(data.base64, data.mimeType, data.fileName);
    } else if (message.type === "text_input" && typeof message.text === "string") {
      this.handleTextInput(message.text);
    }
  }
  handleFileUpload(base64, mimeType, fileName) {
    if (!this.sessionManager.isActive) return;
    this.transport.sendFile(base64, mimeType);
    this.conversationContext.addUserMessage(`[Uploaded file: ${fileName ?? "file"}]`);
    if (this.config.artifactRegistry && mimeType.startsWith("image/")) {
      try {
        this.config.artifactRegistry.store(
          base64,
          mimeType,
          fileName ?? `upload_${Date.now()}`,
          "uploaded",
          fileName
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`Failed to store artifact: ${msg}`);
        this.eventBus.publish("gui.notification", {
          sessionId: this.config.sessionId,
          message: `File uploaded to voice session but cannot be forwarded to agents: ${msg}`
        });
      }
    }
  }
  handleTextInput(text) {
    if (!this.sessionManager.isActive || !text.trim()) return;
    const trimmed = text.trim();
    const activeId = this.interactionMode.getActiveToolCallId();
    if (activeId) {
      const session = this.agentRouter.getSubagentSession(activeId);
      if (session?.trySendToSubagent(trimmed)) {
        this.interactionMode.deactivate(activeId);
      }
    }
    this.transport.sendContent([{ role: "user", text: trimmed }], true);
    this.conversationContext.addUserMessage(trimmed);
  }
  handleClientConnected() {
    this.log(`Client connected (geminiActive=${this.sessionManager.isActive})`);
    this.clientConnected = true;
    this.clientTransport.sendJsonToClient({
      type: "session.config",
      audioFormat: this.transport.audioFormat
    });
    this.behaviorManager?.sendCatalog();
    if (this.sessionManager.isActive) {
      this._memoryReadyPromise.then(() => this.sendGreeting());
    }
  }
  handleClientDisconnected() {
    this.log("Client disconnected");
    this.clientConnected = false;
  }
  /** Feed client audio into the session (LLM + STT). Used when the server owns the socket (multi-user). */
  feedAudioFromClient(data) {
    this.handleAudioFromClient(data);
  }
  /** Feed client JSON (text_input, file_upload, etc.) into the session. Used when the server owns the socket. */
  feedJsonFromClient(message) {
    this.handleJsonFromClient(message);
  }
  /** Notify the session that the client connected. Used when the server owns the socket (multi-user). */
  notifyClientConnected() {
    this.handleClientConnected();
  }
  /** Notify the session that the client disconnected. Used when the server owns the socket (multi-user). */
  notifyClientDisconnected() {
    this.handleClientDisconnected();
  }
  /** Session ID for logging and multi-user association. */
  getSessionId() {
    return this.config.sessionId;
  }
  // --- Error handling ---
  handleTransportError(error) {
    const err = error instanceof Error ? error : error.error;
    this.log(`Transport error: ${err.message}`);
    this.reportError("llm-transport", err);
  }
  handleTransportClose(code, reason) {
    const detail = code != null ? ` code=${code}${reason ? ` reason="${reason}"` : ""}` : "";
    this.log(`Transport closed (state=${this.sessionManager.state}${detail})`);
    if (this.sessionManager.state === "ACTIVE") {
      const handle = this.sessionManager.resumptionHandle;
      if (handle && this.reconnectAttempts < _VoiceSession.MAX_RECONNECT_ATTEMPTS) {
        const attempt = this.reconnectAttempts++;
        const delay = _VoiceSession.RECONNECT_BACKOFF_MS[attempt] ?? 4e3;
        this.log(
          `Reconnect attempt ${attempt + 1}/${_VoiceSession.MAX_RECONNECT_ATTEMPTS} in ${delay}ms`
        );
        this.sessionManager.transitionTo("RECONNECTING");
        this.clientTransport.startBuffering();
        setTimeout(() => {
          this.transport.reconnect({ conversationHistory: this.conversationContext.toReplayContent() }).then(() => {
            const buffered = this.clientTransport.stopBuffering();
            for (const chunk of buffered) {
              this.transport.sendAudio(chunk.toString("base64"));
            }
            this.sessionManager.transitionTo("ACTIVE");
          }).catch((err) => {
            this.clientTransport.stopBuffering();
            this.reportError("reconnect", err);
            this.sessionManager.transitionTo("CLOSED");
          });
        }, delay);
      } else {
        if (this.reconnectAttempts >= _VoiceSession.MAX_RECONNECT_ATTEMPTS) {
          this.log(
            `Reconnect limit reached (${_VoiceSession.MAX_RECONNECT_ATTEMPTS} attempts), giving up`
          );
        }
        this.sessionManager.transitionTo("CLOSED");
      }
    }
  }
  reportError(component, error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (this.hooks.onError) {
      this.hooks.onError({
        sessionId: this.config.sessionId,
        component,
        error: err,
        severity: "error"
      });
    }
  }
  /** Compact diagnostic log: HH:MM:SS.mmm [VoiceSession] message */
  log(msg) {
    const t = (/* @__PURE__ */ new Date()).toISOString().slice(11, 23);
    console.log(`${t} [VoiceSession] ${msg}`);
  }
};

export {
  createAgentContext,
  FrameworkError,
  TransportError,
  SessionError,
  ToolExecutionError,
  AgentError,
  MemoryError,
  ValidationError,
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_EXTRACTION_TIMEOUT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_RECONNECT_TIMEOUT_MS,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  CancelledError,
  InputTimeoutError,
  SessionCompletedError,
  SubagentSessionImpl,
  createAskUserTool,
  runSubagent,
  AgentRouter,
  BackgroundNotificationQueue,
  DirectiveManager,
  InteractionModeManager,
  EventBus,
  HooksManager,
  ConversationContext,
  ConversationHistoryWriter,
  SessionManager,
  MemoryCacheManager,
  MemoryDistiller,
  ToolExecutor,
  AUDIO_FORMAT,
  AudioBuffer,
  ClientSenderAdapter,
  normalizeOpenAIResponseUsage,
  normalizeOpenAITranscriptionUsage,
  zodToJsonSchema,
  GeminiLiveTransport,
  ToolCallRouter,
  TranscriptManager,
  VoiceSession
};
//# sourceMappingURL=chunk-WIPPBHMV.js.map