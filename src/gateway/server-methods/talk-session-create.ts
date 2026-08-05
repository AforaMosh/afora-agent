import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkSessionCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { buildAgentMainSessionKey } from "../../routing/session-key.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../../talk/agent-run-control-shared.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import { ensureClientVoiceAgentSessionEntry } from "../../talk/client-voice-session.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../talk/provider-resolver.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import { createTalkHandoff } from "../talk-handoff.js";
import { createTalkRealtimeRelaySession } from "../talk-realtime-relay.js";
import { rememberUnifiedTalkSession } from "../talk-session-registry.js";
import { createTalkTranscriptionRelaySession } from "../talk-transcription-relay.js";
import { respondInvalidRequest, respondOk, respondUnavailable } from "./talk-session-response.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  buildTalkTranscriptionConfig,
  canUseTalkDirectTools,
  normalizeTalkSessionBrain,
  normalizeTalkSessionMode,
  normalizeTalkSessionTransport,
  resolveConfiguredRealtimeTranscriptionProvider,
  resolveTalkRealtimeGatewayRelayLaunch,
  resolveTalkRealtimeProviderInstructions,
} from "./talk-shared.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

const canCreateUnscopedManagedRoomSession = (
  client: { connect?: { scopes?: string[] } } | null,
): boolean => client?.connect?.scopes?.includes(ADMIN_SCOPE) === true;

export const createTalkSession: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
}) => {
  if (!assertValidParams(params, validateTalkSessionCreateParams, "talk.session.create", respond)) {
    return;
  }

  const mode = normalizeTalkSessionMode(params);
  const transport = normalizeTalkSessionTransport({ mode, transport: params.transport });
  const brain = normalizeTalkSessionBrain({ mode, brain: params.brain });

  if (transport === "webrtc" || transport === "provider-websocket") {
    respondInvalidRequest(
      respond,
      `talk.session.create is Gateway-managed; use talk.client.create for client transport "${transport}"`,
    );
    return;
  }

  try {
    if (transport === "managed-room") {
      if (brain === "direct-tools" && !canUseTalkDirectTools(client)) {
        respondInvalidRequest(
          respond,
          `talk.session.create brain="direct-tools" requires gateway scope: ${ADMIN_SCOPE}`,
        );
        return;
      }
      const spawnedBy = normalizeOptionalString(params.spawnedBy);
      if (
        normalizeOptionalString(params.sessionKey) &&
        !spawnedBy &&
        !canCreateUnscopedManagedRoomSession(client)
      ) {
        respondInvalidRequest(
          respond,
          `talk.session.create managed-room sessionKey requires spawnedBy or gateway scope: ${ADMIN_SCOPE}`,
        );
        return;
      }
      const resolvedSession = await resolveSessionKeyFromResolveParams({
        cfg: context.getRuntimeConfig(),
        p: {
          key: params.sessionKey,
          ...(spawnedBy ? { spawnedBy } : {}),
          includeGlobal: true,
          includeUnknown: true,
        },
      });
      if (!resolvedSession.ok) {
        respond(false, undefined, resolvedSession.error);
        return;
      }
      if ("missing" in resolvedSession) {
        respondInvalidRequest(respond, `No session found: ${params.sessionKey}`);
        return;
      }
      const handoff = createTalkHandoff({
        sessionKey: resolvedSession.key,
        provider: normalizeOptionalString(params.provider),
        model: normalizeOptionalString(params.model),
        voice: normalizeOptionalString(params.voice),
        mode,
        transport,
        brain,
        ttlMs: params.ttlMs,
      });
      rememberUnifiedTalkSession(handoff.id, {
        kind: "managed-room",
        handoffId: handoff.id,
        token: handoff.token,
        roomId: handoff.roomId,
      });
      return respondOk(respond, {
        sessionId: handoff.id,
        provider: handoff.provider,
        mode: handoff.mode,
        transport: handoff.transport,
        brain: handoff.brain,
        handoffId: handoff.id,
        roomId: handoff.roomId,
        roomUrl: handoff.roomUrl,
        token: handoff.token,
        model: handoff.model,
        voice: handoff.voice,
        expiresAt: handoff.expiresAt,
      });
    }

    const connId = client?.connId;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Talk session unavailable"));
      return;
    }

    if (mode === "realtime") {
      if (transport !== "gateway-relay" || brain !== "agent-consult") {
        return respondInvalidRequest(
          respond,
          `realtime talk.session.create requires transport="gateway-relay" and brain="agent-consult"`,
        );
      }
      const runtimeConfig = context.getRuntimeConfig();
      const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, params.provider);
      const launchOptions = buildRealtimeVoiceLaunchOptions({
        requested: params,
        defaults: realtimeConfig,
      });
      const agentId = resolveTalkSessionAgentId(runtimeConfig, params.sessionKey);
      const resolution = resolveConfiguredRealtimeVoiceProvider({
        configuredProviderId: realtimeConfig.provider,
        providerConfigs: realtimeConfig.providers,
        providerConfigOverrides: launchOptions.model ? { model: launchOptions.model } : {},
        cfg: runtimeConfig,
        agentId,
        defaultModel: realtimeConfig.model,
        surface: "gateway-relay",
      });
      const relayLaunch = resolveTalkRealtimeGatewayRelayLaunch({
        ...resolution,
        cfg: runtimeConfig,
        launchOptions,
        consultRouting: realtimeConfig.consultRouting,
      });
      if (relayLaunch.error) {
        // GPT-Live delegates natively; forced transcript consults are a GA-model mode.
        return respondInvalidRequest(respond, relayLaunch.error);
      }
      const realtimeContext = await resolveTalkRealtimeProviderInstructions({
        config: runtimeConfig,
        agentId,
        configuredInstructions: realtimeConfig.instructions,
        sessionKey: params.sessionKey,
        requireSessionKeyForProfile: true,
        warn: (message) => context.logGateway.warn(`talk realtime context: ${message}`),
      });
      const sessionKey =
        realtimeContext.requestedSessionKey ??
        buildAgentMainSessionKey({ agentId: realtimeContext.agentId });
      await ensureClientVoiceAgentSessionEntry({ agentId: realtimeContext.agentId, sessionKey });
      const session = createTalkRealtimeRelaySession({
        context,
        connId,
        cfg: runtimeConfig,
        agentId: realtimeContext.agentId,
        provider: resolution.provider,
        providerConfig: relayLaunch.providerConfig,
        instructions: buildRealtimeInstructions(realtimeContext.instructions),
        tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL],
        model: launchOptions.model,
        sessionKey,
        voice: launchOptions.voice,
        language: normalizeOptionalLowercaseString(params.language),
        forceAgentConsultOnFinalTranscript: relayLaunch.forceAgentConsultOnFinalTranscript,
      });
      rememberUnifiedTalkSession(session.relaySessionId, {
        kind: "realtime-relay",
        connId,
        relaySessionId: session.relaySessionId,
      });
      respondOk(respond, {
        ...session,
        sessionId: session.relaySessionId,
        voiceSessionId: session.relaySessionId,
        mode,
        brain,
      });
      return;
    }

    if (mode === "transcription") {
      if (transport !== "gateway-relay" || brain !== "none") {
        respondInvalidRequest(
          respond,
          `transcription talk.session.create requires transport="gateway-relay" and brain="none"`,
        );
        return;
      }
      const runtimeConfig = context.getRuntimeConfig();
      const transcriptionConfig = buildTalkTranscriptionConfig(runtimeConfig, params.provider);
      const resolution = resolveConfiguredRealtimeTranscriptionProvider({
        config: runtimeConfig,
        configuredProviderId: transcriptionConfig.provider,
        providerConfigs: transcriptionConfig.providers,
        defaultModel: transcriptionConfig.model,
      });
      const session = createTalkTranscriptionRelaySession({
        context,
        connId,
        provider: resolution.provider,
        providerConfig: resolution.providerConfig,
      });
      rememberUnifiedTalkSession(session.transcriptionSessionId, {
        kind: "transcription-relay",
        connId,
        transcriptionSessionId: session.transcriptionSessionId,
      });
      respondOk(respond, {
        ...session,
        sessionId: session.transcriptionSessionId,
        brain,
      });
      return;
    }

    respondInvalidRequest(respond, `stt-tts talk.session.create requires transport="managed-room"`);
  } catch (err) {
    respondUnavailable(respond, err);
  }
};
