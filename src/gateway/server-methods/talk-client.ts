// Talk client methods route lifecycle, tool, transcript, close, and steer requests.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkClientCloseParams,
  validateTalkClientSteerParams,
  validateTalkClientToolCallParams,
  validateTalkClientTranscriptParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  parseRealtimeVoiceAgentConsultArgs,
} from "../../talk/agent-consult-tool.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import {
  authorizeClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
  type ClientVoiceConfirmationGrant,
} from "../../talk/client-voice-confirmation.js";
import {
  appendClientVoiceTranscript,
  assertClientVoiceSessionOpen,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
  registerClientVoiceConsultRun,
  resolveClientVoiceSessionOrigin,
  resolveOpenClientVoiceSessionId,
} from "../../talk/client-voice-session.js";
import { startTalkRealtimeAgentConsult } from "../talk-agent-consult.js";
import * as browserSession from "../talk-client-browser-session.js";
import {
  ensureTalkRealtimeRelayVoiceSession,
  flushTalkRealtimeRelayVoiceWrites,
} from "../talk-realtime-relay.js";
import { formatForLog } from "../ws-log.js";
import { createTalkClientSession } from "./talk-client-create.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";
const LEGACY_VOICE_BINDING_TTL_MS = 6 * 60 * 60_000;
const legacyVoiceSessionByClient = new Map<string, { voiceSessionId: string; expiresAt: number }>();

function legacyVoiceBindingKey(connId: string, sessionKey: string): string {
  return `${connId}\0${sessionKey}`;
}

function pruneLegacyVoiceBindings(now = Date.now()): void {
  for (const [key, binding] of legacyVoiceSessionByClient) {
    if (binding.expiresAt <= now) {
      legacyVoiceSessionByClient.delete(key);
    }
  }
}

function resolveTalkClientAgentId(
  config: Parameters<typeof resolveTalkSessionAgentId>[0],
  key: string,
) {
  return resolveTalkSessionAgentId(config, key);
}

/** Browser-owned realtime Talk creation, lifecycle, and client tool routing. */
export const talkClientHandlers: GatewayRequestHandlers = {
  "talk.client.create": createTalkClientSession,
  "talk.client.commit": (request) =>
    browserSession.mutateBrowserAllocationRequest(request, "commit"),
  "talk.client.abort": (request) => browserSession.mutateBrowserAllocationRequest(request, "abort"),
  "talk.client.toolCall": async (request) => {
    const { params, respond } = request;
    if (
      !assertValidParams(params, validateTalkClientToolCallParams, "talk.client.toolCall", respond)
    ) {
      return;
    }
    if (params.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported realtime Talk tool: ${params.name}`),
      );
      return;
    }

    const config = request.context.getRuntimeConfig();
    const agentId = resolveTalkClientAgentId(config, params.sessionKey);
    const relaySessionId = normalizeOptionalString(params.relaySessionId);
    const connId = normalizeOptionalString(request.client?.connId);
    pruneLegacyVoiceBindings();
    const explicitVoiceSessionId = normalizeOptionalString(params.voiceSessionId);
    if (relaySessionId && explicitVoiceSessionId && explicitVoiceSessionId !== relaySessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "relaySessionId and voiceSessionId must match"),
      );
      return;
    }
    let confirmationGrant: ClientVoiceConfirmationGrant | undefined;
    let voiceSessionId: string;
    try {
      // Shipped clients may consult without ever creating a voice session (old app,
      // restarted gateway, ambiguous open records). Implicitly create one instead of
      // erroring so confirmation and mutation evidence stay always-on.
      voiceSessionId =
        explicitVoiceSessionId ??
        relaySessionId ??
        (connId
          ? legacyVoiceSessionByClient.get(legacyVoiceBindingKey(connId, params.sessionKey))
              ?.voiceSessionId
          : undefined) ??
        resolveOpenClientVoiceSessionId({ agentId, sessionKey: params.sessionKey }) ??
        createOrResumeClientVoiceSession({
          agentId,
          sessionKey: params.sessionKey,
          origin: "client",
        });
      // Pin the resolved id to this connection so a legacy client's later consults
      // reuse one record instead of forking a new never-closed session each time.
      if (connId && !relaySessionId) {
        const now = Date.now();
        pruneLegacyVoiceBindings(now);
        legacyVoiceSessionByClient.set(legacyVoiceBindingKey(connId, params.sessionKey), {
          voiceSessionId,
          expiresAt: now + LEGACY_VOICE_BINDING_TTL_MS,
        });
      }
      if (relaySessionId && connId) {
        // Initialize the canonical session row BEFORE binding: the bind drains the
        // relay's buffered finals into transcript appends, which fail without it.
        await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey: params.sessionKey });
        ensureTalkRealtimeRelayVoiceSession({
          relaySessionId,
          connId,
          sessionKey: params.sessionKey,
        });
        await flushTalkRealtimeRelayVoiceWrites({ relaySessionId, connId });
      }
      const parsedArgs = parseRealtimeVoiceAgentConsultArgs(params.args ?? {});
      const origin = assertClientVoiceSessionOpen({
        agentId,
        sessionKey: params.sessionKey,
        voiceSessionId,
      });
      if (origin === "relay" && (!relaySessionId || !connId)) {
        throw new Error(
          "relay-owned voice sessions require relaySessionId and connection ownership",
        );
      }
      if (parsedArgs.confirmationId) {
        confirmationGrant = authorizeClientVoiceConfirmation({
          agentId,
          voiceSessionId,
          confirmationId: parsedArgs.confirmationId,
        });
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
      return;
    }

    const result = await startTalkRealtimeAgentConsult({
      context: request.context,
      client: request.client,
      isWebchatConnect: request.isWebchatConnect,
      requestId: request.req.id,
      sessionKey: params.sessionKey,
      callId: params.callId,
      args: params.args ?? {},
      relaySessionId: normalizeOptionalString(params.relaySessionId),
      connId,
      onRunStarted: (runId) => {
        registerClientVoiceConsultRun({
          agentId,
          sessionKey: params.sessionKey,
          voiceSessionId,
          runId,
          config: request.context.getRuntimeConfig(),
        });
        if (confirmationGrant) {
          bindAuthorizedClientVoiceConfirmation({ grant: confirmationGrant, runId });
        }
      },
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(
      true,
      {
        runId: result.runId,
        idempotencyKey: result.idempotencyKey,
      },
      undefined,
    );
  },
  "talk.client.transcript": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateTalkClientTranscriptParams,
        "talk.client.transcript",
        respond,
      )
    ) {
      return;
    }
    try {
      const config = context.getRuntimeConfig();
      await appendClientVoiceTranscript({
        agentId: resolveTalkClientAgentId(config, params.sessionKey),
        sessionKey: params.sessionKey,
        voiceSessionId: params.voiceSessionId,
        entryId: params.entryId,
        role: params.role,
        text: params.text,
        ...(params.timestamp !== undefined ? { timestamp: params.timestamp } : {}),
        config,
      });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    }
  },
  "talk.client.close": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateTalkClientCloseParams, "talk.client.close", respond)) {
      return;
    }
    try {
      const config = context.getRuntimeConfig();
      const agentId = resolveTalkClientAgentId(config, params.sessionKey);
      const identity = {
        agentId,
        sessionKey: params.sessionKey,
        voiceSessionId: params.voiceSessionId,
      };
      const connId = normalizeOptionalString(client?.connId);
      if (params.allocationId) {
        await browserSession.closeBrowserAllocationForClient({
          ...identity,
          allocationId: params.allocationId,
          connId,
          config,
        });
        if (connId) {
          const key = legacyVoiceBindingKey(connId, params.sessionKey);
          if (legacyVoiceSessionByClient.get(key)?.voiceSessionId === params.voiceSessionId) {
            legacyVoiceSessionByClient.delete(key);
          }
        }
        respond(true, { ok: true }, undefined);
        return;
      }
      const origin = resolveClientVoiceSessionOrigin({
        ...identity,
      });
      if (origin === "relay") {
        throw new Error("relay-owned voice sessions close through talk.session.close");
      }
      await browserSession.closeBrowserAllocationForClient({
        ...identity,
        connId,
        config,
      });
      if (connId) {
        const key = legacyVoiceBindingKey(connId, params.sessionKey);
        if (legacyVoiceSessionByClient.get(key)?.voiceSessionId === params.voiceSessionId) {
          legacyVoiceSessionByClient.delete(key);
        }
      }
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    }
  },
  "talk.client.steer": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateTalkClientSteerParams, "talk.client.steer", respond)) {
      return;
    }
    if (
      !hasOwnedActiveTalkClientRun({
        context,
        clientConnId: client?.connId,
        sessionKey: params.sessionKey,
      })
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "talk.client.steer requires an active browser-owned Talk run",
        ),
      );
      return;
    }
    try {
      const result = await controlRealtimeVoiceAgentRun({
        sessionKey: params.sessionKey,
        text: params.text,
        mode: params.mode,
      });
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};

function hasOwnedActiveTalkClientRun(params: {
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"];
  clientConnId?: string;
  sessionKey: string;
}): boolean {
  // Browser steering is only allowed for the connection that owns the live
  // browser session; agent-owned consult runs use the relay steering path.
  const connId = normalizeOptionalString(params.clientConnId);
  const sessionKey = params.sessionKey.trim();
  if (!connId || !sessionKey) {
    return false;
  }
  for (const entry of params.context.chatAbortControllers.values()) {
    if (entry.sessionKey === sessionKey && entry.ownerConnId === connId && entry.kind !== "agent") {
      return true;
    }
  }
  return false;
}
