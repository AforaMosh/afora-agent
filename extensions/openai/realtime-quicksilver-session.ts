// Native GPT-Live browser sessions: WebRTC offer broker plus gateway-owned sideband control.
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderOAuthAccess } from "openclaw/plugin-sdk/provider-auth";
import type {
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceProviderCapabilities,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  readRequestBodyWithLimit,
  resolveAcceptedBrowserOrigin,
} from "openclaw/plugin-sdk/webhook-request-guards";
import WebSocket, { type RawData } from "ws";
import { resolveCodexAuthIdentity } from "./openai-chatgpt-auth-identity.js";
import { OpenAIQuicksilverDelegationController } from "./realtime-quicksilver-delegation-controller.js";
import {
  releaseOpenAIQuicksilverSession,
  reserveOpenAIQuicksilverSession,
  transferOpenAIQuicksilverSession,
} from "./realtime-quicksilver-session-limit.js";
import {
  connectOpenAIQuicksilverSideband,
  type OpenAIQuicksilverSocket,
  type OpenAIQuicksilverSocketFactory,
} from "./realtime-quicksilver-sideband.js";
import {
  buildOpenAIQuicksilverSession,
  createOpenAIQuicksilverCall,
  resolveOpenAIQuicksilverVoice,
  type OpenAIQuicksilverAuth,
  type OpenAIQuicksilverInitialItem,
  type OpenAIQuicksilverRequestIds,
} from "./realtime-quicksilver-wire.js";
import { isOpenAIGptLiveModel } from "./realtime-quicksilver.js";
export const OPENAI_QUICKSILVER_OFFER_PATH = "/plugins/openai/realtime/calls";
export const OPENAI_QUICKSILVER_CAPABILITIES = {
  transports: ["webrtc" as const, "gateway-relay" as const],
  handlesAgentConsult: true as const,
  supportsToolCalls: false,
  supportsVideoFrames: false,
} satisfies Partial<RealtimeVoiceProviderCapabilities> & { handlesAgentConsult: true };

const OPENAI_QUICKSILVER_PENDING_TTL_MS = 60_000;
const OPENAI_QUICKSILVER_SESSION_TTL_MS = 30 * 60_000;
const OPENAI_QUICKSILVER_MAX_SDP_BYTES = 256 * 1024;
const OPENAI_QUICKSILVER_UPSTREAM_TIMEOUT_MS = 30_000;
const WEBSOCKET_OPEN = 1;
const TERMINAL_HOOK = Symbol.for("openclaw.internal.realtime-voice-browser-session-terminal.v1");
type TerminalOutcome = { outcome: "completed" | "error"; message?: string };

type OpenAIQuicksilverSessionRequest = RealtimeVoiceBrowserSessionCreateRequest & {
  initialItems?: OpenAIQuicksilverInitialItem[];
};

type PreparedOpenAIQuicksilverSessionRequest = OpenAIQuicksilverSessionRequest & {
  model: string;
  voice: string;
};

type PendingOffer = {
  auth: OpenAIQuicksilverAuth;
  expiresAt: number;
  requestIds: OpenAIQuicksilverRequestIds;
  request: PreparedOpenAIQuicksilverSessionRequest;
};

type InFlightOffer = { abortController: AbortController };

type ActiveSession = {
  abortController: AbortController;
  delegations: OpenAIQuicksilverDelegationController;
  onTerminal?: (outcome: TerminalOutcome) => void;
  ready: boolean;
  socket?: OpenAIQuicksilverSocket;
  timer?: NodeJS.Timeout;
  token: string;
};

type ResponseDeliveryWaiter = {
  result: Promise<boolean>;
  cancel: () => void;
};
const clearTimer = (timer?: NodeJS.Timeout) => timer && clearTimeout(timer);

function createResponseDeliveryWaiter(
  res: ServerResponse,
  onDelivered: () => void,
): ResponseDeliveryWaiter {
  let settle!: (delivered: boolean) => void;
  const result = new Promise<boolean>((resolve) => {
    settle = (delivered) => {
      res.removeListener("finish", onFinish);
      res.removeListener("close", onClose);
      resolve(delivered);
    };
  });
  const onFinish = () => {
    onDelivered();
    settle(true);
  };
  const onClose = () => settle(false);
  res.once("finish", onFinish);
  res.once("close", onClose);
  return { result, cancel: () => settle(false) };
}

function respondText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

function applyRealtimeOfferCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: OpenClawConfig | undefined,
): boolean {
  if (!req.headers.origin) {
    return true;
  }
  const origin = resolveAcceptedBrowserOrigin({ req, cfg });
  if (!origin) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  return true;
}

function readBearerToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization?.trim();
  return authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
}

export async function resolveOpenAIChatGptSubscriptionAuth(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
}): Promise<Extract<OpenAIQuicksilverAuth, { type: "oauth" }> | undefined> {
  const access = await resolveProviderOAuthAccess({
    provider: "openai",
    cfg: params.cfg,
    agentDir: params.agentDir,
    includeExternalCliAuth: false,
  });
  if (!access) {
    return undefined;
  }
  const accountId =
    access.accountId ?? resolveCodexAuthIdentity({ accessToken: access.accessToken }).accountId;
  if (!accountId) {
    throw new Error("The selected ChatGPT OAuth profile is missing its account id");
  }
  return { type: "oauth", token: access.accessToken, accountId };
}

export function createOpenAIQuicksilverBrowserSessionBroker(params: {
  getConfig: () => OpenClawConfig | undefined;
  logger: Pick<PluginLogger, "debug" | "warn">;
  fetchImpl?: typeof fetch;
  webSocketFactory?: OpenAIQuicksilverSocketFactory;
}): {
  broker: {
    capabilities: Partial<RealtimeVoiceProviderCapabilities> & { handlesAgentConsult: true };
    createBrowserSession: (
      request: OpenAIQuicksilverSessionRequest,
      auth: OpenAIQuicksilverAuth,
    ) => Promise<RealtimeVoiceBrowserSession>;
    cancelBrowserSession: (session: RealtimeVoiceBrowserSession) => void;
  };
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  cleanup: () => Promise<void>;
} {
  const pendingOffers = new Map<string, PendingOffer>();
  const inFlightOffers = new Map<string, InFlightOffer>();
  const activeSessions = new Map<string, ActiveSession>();
  const inFlightHandlers = new Set<Promise<boolean>>();
  const inFlightSideband = new Set<Promise<void>>();
  const shutdownController = new AbortController();
  const createSocket = params.webSocketFactory ?? ((url, options) => new WebSocket(url, options));
  let cleanedUp = false;

  const finalizeSession = (
    session: ActiveSession,
    outcome?: TerminalOutcome,
    reason = "closed",
  ) => {
    if (activeSessions.get(session.token) !== session) {
      return false;
    }
    activeSessions.delete(session.token);
    releaseOpenAIQuicksilverSession(session);
    clearTimer(session.timer);
    const socket = session.socket;
    session.socket = undefined;
    session.delegations.detach();
    session.abortController.abort(new Error(outcome?.message ?? reason));
    if (socket?.readyState === WEBSOCKET_OPEN) {
      try {
        socket.send(JSON.stringify({ type: "session.close" }));
      } catch {
        // The peer may have closed between readyState and send.
      }
    }
    if (socket) {
      try {
        socket.close(1000, reason);
      } catch {
        // Socket teardown is best effort after ownership has been released.
      }
    }
    if (outcome) {
      session.onTerminal?.(outcome);
    }
    return true;
  };
  const failSession = (session: ActiveSession, message: string, reason: string) =>
    finalizeSession(session, { outcome: "error", message }, reason);

  const scheduleSessionExpiry = (session: ActiveSession, ttlMs: number) => {
    clearTimer(session.timer);
    session.timer = setTimeout(
      () => failSession(session, "OpenAI GPT-Live session expired", "session expired"),
      Math.max(0, ttlMs),
    );
    session.timer.unref?.();
  };

  const handleSidebandFrame = (session: ActiveSession, data: RawData, isBinary: boolean) => {
    session.delegations.handleFrame(data, isBinary);
  };

  const closeOutcome = (session: ActiveSession, code: number): TerminalOutcome =>
    session.ready && code === 1000
      ? { outcome: "completed" }
      : {
          outcome: "error",
          message: session.ready
            ? `OpenAI GPT-Live sideband closed unexpectedly (${code || 1006})`
            : "OpenAI GPT-Live sideband closed before session.started",
        };

  const attachSidebandHandlers = (session: ActiveSession, socket: OpenAIQuicksilverSocket) => {
    socket.on("message", (data: RawData, isBinary: boolean) => {
      handleSidebandFrame(session, data, isBinary);
    });
    socket.on("error", (error: Error) => {
      params.logger.warn(`OpenAI GPT-Live sideband socket failed: ${error.message}`);
      finalizeSession(session, { outcome: "error", message: error.message }, "sideband failed");
    });
    socket.on("close", (code: number) => {
      finalizeSession(session, closeOutcome(session, code), "sideband closed");
    });
  };

  const startSideband = (session: ActiveSession, offer: PendingOffer, url: string) => {
    const task = (async () => {
      try {
        const connected = await connectOpenAIQuicksilverSideband({
          auth: offer.auth,
          createSocket,
          requestIds: offer.requestIds,
          signal: session.abortController.signal,
          url,
        });
        if (activeSessions.get(session.token) !== session) {
          connected.detachBuffer();
          connected.socket.on("error", () => {});
          connected.socket.close(1000, "stale sideband");
          return;
        }
        session.socket = connected.socket;
        attachSidebandHandlers(session, connected.socket);
        const terminal = connected.detachBuffer();
        for (const frame of connected.bufferedFrames) {
          handleSidebandFrame(session, frame.data, frame.isBinary);
        }
        if (terminal?.kind === "error") {
          params.logger.warn(`OpenAI GPT-Live sideband socket failed: ${terminal.error.message}`);
          failSession(session, terminal.error.message, "sideband failed");
        } else if (terminal) {
          finalizeSession(session, closeOutcome(session, terminal.code), "sideband closed");
        }
      } catch (cause) {
        if (activeSessions.get(session.token) !== session) {
          return;
        }
        const error = cause instanceof Error ? cause : new Error("OpenAI GPT-Live sideband failed");
        params.logger.warn(`OpenAI GPT-Live sideband connection failed: ${error.message}`);
        failSession(session, error.message, "sideband connection failed");
      }
    })();
    inFlightSideband.add(task);
    void task.finally(() => inFlightSideband.delete(task));
  };

  const prunePendingOffers = () => {
    const now = Date.now();
    for (const [token, offer] of pendingOffers) {
      if (offer.expiresAt <= now) {
        pendingOffers.delete(token);
        releaseOpenAIQuicksilverSession(token);
      }
    }
  };

  const broker = {
    capabilities: OPENAI_QUICKSILVER_CAPABILITIES,
    createBrowserSession: async (
      request: OpenAIQuicksilverSessionRequest,
      auth: OpenAIQuicksilverAuth,
    ): Promise<RealtimeVoiceBrowserSession> => {
      if (cleanedUp || shutdownController.signal.aborted) {
        throw new Error("OpenAI GPT-Live sessions are stopping; restart Gateway and try again");
      }
      const model = request.model?.trim();
      if (!model) {
        throw new Error("OpenAI realtime browser sessions require a model");
      }
      if (isOpenAIGptLiveModel(model) && !request.runAgentConsult) {
        throw new Error("OpenAI GPT-Live requires the Gateway agent-consult runtime");
      }
      prunePendingOffers();
      const voice = resolveOpenAIQuicksilverVoice(request.voice);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + OPENAI_QUICKSILVER_PENDING_TTL_MS;
      reserveOpenAIQuicksilverSession(token, { expiresAtMs: expiresAt });
      pendingOffers.set(token, {
        auth,
        expiresAt,
        requestIds: {
          realtimeSessionId: randomUUID(),
          sessionId: randomUUID(),
          threadId: randomUUID(),
        },
        request: { ...request, model, voice },
      });
      return {
        provider: "openai",
        transport: "webrtc",
        clientSecret: token,
        offerUrl: OPENAI_QUICKSILVER_OFFER_PATH,
        model,
        voice,
        expiresAt,
      };
    },
    cancelBrowserSession: (session: RealtimeVoiceBrowserSession) => {
      if (session.transport !== "webrtc") {
        return;
      }
      const pending = pendingOffers.delete(session.clientSecret);
      const inFlight = inFlightOffers.get(session.clientSecret);
      inFlight?.abortController.abort(new Error("GPT-Live session canceled"));
      const active = activeSessions.get(session.clientSecret);
      if (active) {
        finalizeSession(active, undefined, "session canceled");
      } else if (pending) {
        releaseOpenAIQuicksilverSession(session.clientSecret);
      }
    },
  };

  const handleOffer = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const corsAllowed = applyRealtimeOfferCorsHeaders(req, res, params.getConfig());
    if (req.method === "OPTIONS") {
      if (!corsAllowed) {
        respondText(res, 403, "Origin not allowed");
        return true;
      }
      res.statusCode = 204;
      res.setHeader("cache-control", "no-store");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader(
        "Vary",
        "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
      );
      if (req.headers["access-control-request-private-network"] === "true") {
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      res.setHeader("Access-Control-Max-Age", "600");
      res.end();
      return true;
    }
    if (!corsAllowed) {
      respondText(res, 403, "Origin not allowed");
      return true;
    }
    if (req.method !== "POST") {
      respondText(res, 405, "Method not allowed");
      return true;
    }
    if (!req.headers["content-type"]?.toLowerCase().startsWith("application/sdp")) {
      respondText(res, 415, "Expected application/sdp");
      return true;
    }
    prunePendingOffers();
    const token = readBearerToken(req);
    const offer = token ? pendingOffers.get(token) : undefined;
    if (!token || !offer || offer.expiresAt <= Date.now()) {
      respondText(res, 401, "Invalid or expired realtime session token");
      return true;
    }
    // Offer credentials are single-use so a captured browser request cannot join twice.
    pendingOffers.delete(token);
    const inFlight = { abortController: new AbortController() };
    transferOpenAIQuicksilverSession(token, inFlight);
    let browserDisconnected = false;
    inFlightOffers.set(token, inFlight);
    const abortFromBrowser = () => {
      browserDisconnected = true;
      inFlight.abortController.abort(new Error("Browser GPT-Live offer request closed"));
    };
    req.once("aborted", abortFromBrowser);
    res.once("close", abortFromBrowser);
    const detachBrowserAbort = () => {
      req.removeListener("aborted", abortFromBrowser);
      res.removeListener("close", abortFromBrowser);
    };
    const lifecycleSignal = AbortSignal.any([
      shutdownController.signal,
      inFlight.abortController.signal,
    ]);
    let session: ActiveSession | undefined;
    let reservationTransferred = false;
    let responseDeliveryWaiter: ResponseDeliveryWaiter | undefined;
    try {
      const sdp = await readRequestBodyWithLimit(req, {
        maxBytes: OPENAI_QUICKSILVER_MAX_SDP_BYTES,
        timeoutMs: 15_000,
      });
      if (!sdp.trim()) {
        respondText(res, 400, "SDP offer is required");
        return true;
      }
      const upstreamSignal = AbortSignal.any([
        lifecycleSignal,
        AbortSignal.timeout(OPENAI_QUICKSILVER_UPSTREAM_TIMEOUT_MS),
      ]);
      const call = await createOpenAIQuicksilverCall({
        auth: offer.auth,
        requestIds: offer.requestIds,
        sdp,
        session: buildOpenAIQuicksilverSession({
          model: offer.request.model,
          instructions: offer.request.instructions,
          voice: offer.request.voice,
          initialItems: offer.request.initialItems,
        }),
        signal: upstreamSignal,
        fetchImpl: params.fetchImpl,
      });
      if (lifecycleSignal.aborted) {
        throw lifecycleSignal.reason;
      }
      if (call.kind === "ga-realtime") {
        res.statusCode = call.status;
        res.setHeader("cache-control", "no-store");
        res.setHeader("content-type", "application/sdp");
        res.setHeader("x-content-type-options", "nosniff");
        res.end(call.answerSdp);
        return true;
      }
      const runAgentConsult = offer.request.runAgentConsult;
      if (!runAgentConsult) {
        throw new Error("OpenAI GPT-Live requires the Gateway agent-consult runtime");
      }
      const abortController = new AbortController();
      const delegations = new OpenAIQuicksilverDelegationController({
        getSocket: () => session?.socket,
        logger: params.logger,
        onFatalError: (error) => {
          if (session) {
            failSession(session, error.message, "fatal sideband error");
          }
        },
        onSessionStarted: (expiresAt) => {
          if (session) {
            session.ready = true;
          }
          if (session && expiresAt !== undefined) {
            const upstreamTtlMs = expiresAt * 1000 - Date.now();
            scheduleSessionExpiry(
              session,
              Math.min(OPENAI_QUICKSILVER_SESSION_TTL_MS, upstreamTtlMs),
            );
          }
        },
        runAgentConsult,
        signal: abortController.signal,
      });
      session = {
        abortController,
        delegations,
        onTerminal: Reflect.get(offer.request, TERMINAL_HOOK) as ActiveSession["onTerminal"],
        ready: false,
        token,
      };
      activeSessions.set(token, session);
      transferOpenAIQuicksilverSession(inFlight, session);
      reservationTransferred = true;
      scheduleSessionExpiry(session, OPENAI_QUICKSILVER_SESSION_TTL_MS);

      responseDeliveryWaiter = createResponseDeliveryWaiter(res, detachBrowserAbort);
      res.statusCode = 200;
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-type", "application/sdp");
      res.setHeader("x-content-type-options", "nosniff");
      res.end(call.answerSdp);
      const delivered = await responseDeliveryWaiter.result;
      responseDeliveryWaiter = undefined;
      if (!delivered || lifecycleSignal.aborted) {
        finalizeSession(session, undefined, "answer not delivered");
        return true;
      }
      startSideband(session, offer, call.sidebandUrl);
      return true;
    } catch (error) {
      if (session) {
        finalizeSession(session, undefined, "session failed");
      }
      if (browserDisconnected) {
        return true;
      }
      respondText(
        res,
        502,
        error instanceof Error ? error.message : "OpenAI GPT-Live session failed",
      );
      return true;
    } finally {
      responseDeliveryWaiter?.cancel();
      detachBrowserAbort();
      inFlightOffers.delete(token);
      if (!reservationTransferred) {
        releaseOpenAIQuicksilverSession(inFlight);
      }
    }
  };

  const handler = (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const handling = handleOffer(req, res);
    inFlightHandlers.add(handling);
    return handling.finally(() => inFlightHandlers.delete(handling));
  };

  const cleanup = async () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    shutdownController.abort(new Error("OpenAI GPT-Live broker stopped"));
    for (const token of pendingOffers.keys()) {
      releaseOpenAIQuicksilverSession(token);
    }
    pendingOffers.clear();
    for (const inFlight of inFlightOffers.values()) {
      inFlight.abortController.abort(new Error("OpenAI GPT-Live broker stopped"));
    }
    for (const session of activeSessions.values()) {
      finalizeSession(session, undefined, "broker stopped");
    }
    await Promise.allSettled(inFlightHandlers);
    await Promise.allSettled(inFlightSideband);
  };

  return { broker, handler, cleanup };
}
