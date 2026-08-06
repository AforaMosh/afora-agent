// Browser-owned realtime Talk session creation.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateTalkClientCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { normalizeTalkSection } from "../../config/talk.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { buildAgentMainSessionKey } from "../../routing/session-key.js";
import { consultRealtimeVoiceAgent } from "../../talk/agent-consult-runtime.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../../talk/agent-run-control-shared.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import {
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSessionWithResult,
  ensureClientVoiceAgentSessionEntry,
  preflightClientVoiceSessionResume,
  registerClientVoiceConsultRun,
  resolveClientVoiceAgentSessionId,
} from "../../talk/client-voice-session.js";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL } from "../../talk/describe-view-tool.js";
import {
  cancelInternalRealtimeVoiceBrowserSession,
  type InternalRealtimeVoiceBrowserSessionCreateRequest,
} from "../../talk/provider-internal.js";
import {
  resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceProviderCapabilities,
} from "../../talk/provider-resolver.js";
import { registerChatAbortController } from "../chat-abort.js";
import { readSessionPreviewItemsFromTranscript } from "../session-transcript-readers.js";
import * as browserSession from "../talk-client-browser-session.js";
import { formatForLog } from "../ws-log.js";
import {
  boundRealtimeVoiceInitialItems,
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  isUnsupportedBrowserWebRtcSession,
  resolveTalkRealtimeProviderInstructions,
} from "./talk-shared.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

const REALTIME_VOICE_CONTEXT_MAX_ITEMS = 16;

const REALTIME_VOICE_CONTEXT_MAX_ITEM_CHARS = 800;

const REALTIME_VOICE_CONTEXT_MAX_UTF8_BYTES = 8_000;

const REALTIME_VOICE_CLIENT_SESSION_MIN_TTL_MS = 5_000;

export const createTalkClientSession: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
}) => {
  if (!assertValidParams(params, validateTalkClientCreateParams, "talk.client.create", respond)) {
    return;
  }
  const typedParams = params as {
    sessionKey?: string;
    voiceSessionId?: string;
    provider?: string;
    model?: string;
    voice?: string;
    vadThreshold?: number;
    silenceDurationMs?: number;
    prefixPaddingMs?: number;
    reasoningEffort?: string;
    mode?: string;
    transport?: string;
    brain?: string;
    capabilities?: string[];
  };
  let creationLease: ReturnType<typeof browserSession.acquireBrowserCreationLease> | undefined;
  try {
    const runtimeConfig = context.getRuntimeConfig();
    const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, typedParams.provider);
    const mode =
      normalizeOptionalLowercaseString(typedParams.mode) ?? realtimeConfig.mode ?? "realtime";
    if (mode !== "realtime") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `talk.client.create only supports mode="realtime"; use talk.catalog for ${mode} provider discovery`,
        ),
      );
      return;
    }
    const brain =
      normalizeOptionalLowercaseString(typedParams.brain) ??
      realtimeConfig.brain ??
      "agent-consult";
    if (brain !== "agent-consult") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `talk.client.create only supports brain="agent-consult"`,
        ),
      );
      return;
    }
    const transport =
      normalizeOptionalLowercaseString(typedParams.transport) ?? realtimeConfig.transport;
    const wantsCameraFrames = typedParams.capabilities?.includes("camera-frame") === true;
    const usesBrowserAllocations = hasGatewayClientCap(
      client?.connect?.caps,
      GATEWAY_CLIENT_CAPS.BROWSER_ALLOCATION_V1,
    );
    if (transport === "managed-room") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "managed-room realtime Talk sessions are not available in the browser UI yet",
        ),
      );
      return;
    }
    if (transport === "gateway-relay") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          wantsCameraFrames
            ? "gateway-relay does not support browser video frames"
            : `talk.client.create is client-owned; use talk.session.create for gateway-relay`,
        ),
      );
      return;
    }
    const launchOptions = buildRealtimeVoiceLaunchOptions({
      requested: typedParams,
      defaults: realtimeConfig,
    });
    const requestedAgentId = resolveTalkSessionAgentId(runtimeConfig, typedParams.sessionKey);
    const resolution = resolveConfiguredRealtimeVoiceProvider({
      configuredProviderId: realtimeConfig.provider,
      providerConfigs: realtimeConfig.providers,
      ...(launchOptions.model ? { providerConfigOverrides: { model: launchOptions.model } } : {}),
      cfg: runtimeConfig,
      cfgForResolve: runtimeConfig,
      agentId: requestedAgentId,
      defaultModel: realtimeConfig.model,
      surface: "browser-session",
      noRegisteredProviderMessage: "No realtime voice provider registered",
    });
    const providerCapabilities = resolveRealtimeVoiceProviderCapabilities({
      provider: resolution.provider,
      providerConfig: resolution.providerConfig,
      cfg: runtimeConfig,
      model: launchOptions.model,
      surface: "browser-session",
    });
    if (wantsCameraFrames && providerCapabilities?.supportsVideoFrames !== true) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Realtime provider ${resolution.provider.id} does not support browser video frames`,
        ),
      );
      return;
    }
    const ownerConnId = normalizeOptionalString(client?.connId);
    if (ownerConnId && resolution.provider.createBrowserSession) {
      // Own startup before the first await so disconnect cleanup fences provider creation.
      creationLease = browserSession.acquireBrowserCreationLease(ownerConnId);
    }
    const realtimeContext = await resolveTalkRealtimeProviderInstructions({
      config: runtimeConfig,
      agentId: requestedAgentId,
      configuredInstructions: realtimeConfig.instructions,
      sessionKey: typedParams.sessionKey,
      // Legacy creates can drift to another agent's session at toolCall time, so
      // the default agent's profile must not leak into the provider session.
      requireSessionKeyForProfile: true,
      warn: (message) => context.logGateway.warn(`talk realtime context: ${message}`),
    });
    creationLease?.assertActive();
    const { agentId, requestedSessionKey } = realtimeContext;
    const sessionKey = requestedSessionKey ?? buildAgentMainSessionKey({ agentId });
    preflightClientVoiceSessionResume({
      agentId,
      sessionKey,
      provider: resolution.provider.id,
      origin: "client",
      voiceSessionId: normalizeOptionalString(typedParams.voiceSessionId),
    });
    if (resolution.provider.createBrowserSession && transport !== "gateway-relay") {
      const agentSessionId = resolveClientVoiceAgentSessionId({ agentId, sessionKey });
      const initialItems = agentSessionId
        ? boundRealtimeVoiceInitialItems(
            readSessionPreviewItemsFromTranscript(
              {
                agentId,
                sessionId: agentSessionId,
                sessionKey,
              },
              REALTIME_VOICE_CONTEXT_MAX_ITEMS,
              REALTIME_VOICE_CONTEXT_MAX_ITEM_CHARS,
            ).filter(
              (
                item,
              ): item is {
                role: "user" | "assistant";
                text: string;
              } => item.role === "user" || item.role === "assistant",
            ),
            REALTIME_VOICE_CONTEXT_MAX_UTF8_BYTES,
          )
        : [];
      const tools =
        providerCapabilities?.supportsToolCalls === false
          ? []
          : [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL];
      if (wantsCameraFrames && tools.length > 0) {
        tools.push(REALTIME_VOICE_DESCRIBE_VIEW_TOOL);
      }
      const instructions =
        providerCapabilities?.handlesAgentConsult === true
          ? normalizeOptionalString(realtimeContext.instructions)
          : buildRealtimeInstructions(realtimeContext.instructions);
      let consultAgentRuntime: ReturnType<typeof createPluginRuntime>["agent"] | undefined;
      let activeVoiceSessionId: string | undefined;
      const runAgentConsult: NonNullable<
        InternalRealtimeVoiceBrowserSessionCreateRequest["runAgentConsult"]
      > = async ({ prompt, signal }) => {
        consultAgentRuntime ??= createPluginRuntime().agent;
        const talkConfig = normalizeTalkSection(runtimeConfig.talk);
        return await consultRealtimeVoiceAgent({
          cfg: runtimeConfig,
          agentRuntime: consultAgentRuntime,
          logger: context.logGateway,
          agentId,
          sessionKey,
          messageProvider: "webchat",
          lane: "talk",
          runIdPrefix: "talk-realtime-consult",
          args: { question: prompt },
          transcript: initialItems,
          surface: "a browser Talk session",
          userLabel: "User",
          questionSourceLabel: "user",
          thinkLevel: talkConfig?.consultThinkingLevel,
          fastMode: talkConfig?.consultFastMode,
          abortSignal: signal,
          onRunStarted: ({ runId, sessionId, timeoutMs }) => {
            // Sideband delegation can start only after create returns the durable voice id.
            const voiceSessionId = activeVoiceSessionId;
            if (!voiceSessionId) {
              throw new Error("Realtime browser voice session is not ready for agent consult");
            }
            registerClientVoiceConsultRun({
              agentId,
              sessionKey,
              voiceSessionId,
              runId,
              config: runtimeConfig,
            });
            if (!ownerConnId) {
              return undefined;
            }
            const registration = registerChatAbortController({
              chatAbortControllers: context.chatAbortControllers,
              runId,
              sessionId,
              sessionKey,
              agentId,
              timeoutMs,
              ownerConnId,
              controlUiVisible: false,
              kind: "chat-send",
            });
            return {
              abortSignal: registration.controller.signal,
              cleanup: registration.cleanup,
            };
          },
        });
      };
      const browserSessionRequest: InternalRealtimeVoiceBrowserSessionCreateRequest = {
        cfg: runtimeConfig,
        agentId,
        workspaceDir: resolveAgentWorkspaceDir(runtimeConfig, agentId),
        providerConfig: resolution.providerConfig,
        instructions,
        initialItems,
        runAgentConsult,
        ...(tools.length > 0 ? { tools } : {}),
        ...launchOptions,
      };
      const session = await resolution.provider.createBrowserSession(browserSessionRequest);
      let canceling: Promise<void> | undefined;
      const cancelSession = () => {
        canceling ??= cancelInternalRealtimeVoiceBrowserSession({
          provider: resolution.provider,
          request: browserSessionRequest,
          session,
        }).catch((error: unknown) => {
          context.logGateway.warn(`talk browser session cleanup failed: ${formatForLog(error)}`);
        });
        return canceling;
      };
      try {
        creationLease?.assertActive();
      } catch (error) {
        await cancelSession();
        throw error;
      }
      // Client-owned voice records are minted only for client-owned transports;
      // relay sessions are created via talk.session.create and keyed by relaySessionId.
      // Widening this guard would hand relay calls a mismatched voiceSessionId.
      if (
        (session.transport === "webrtc" || session.transport === "provider-websocket") &&
        !isUnsupportedBrowserWebRtcSession(session) &&
        (!transport || session.transport === transport)
      ) {
        try {
          const sessionEntryDeadlineAt =
            session.expiresAt === undefined
              ? undefined
              : session.expiresAt - REALTIME_VOICE_CLIENT_SESSION_MIN_TTL_MS;
          if (sessionEntryDeadlineAt !== undefined && Date.now() >= sessionEntryDeadlineAt) {
            throw new Error("Realtime browser session expired during startup; try again");
          }
          // Defer persistence until the provider returns a usable transport. The write
          // boundary rechecks its deadline so queued work cannot leave a phantom chat.
          await ensureClientVoiceAgentSessionEntry({
            agentId,
            sessionKey,
            ...(creationLease ? { assertCommitAllowed: creationLease.assertActive } : {}),
            ...(sessionEntryDeadlineAt !== undefined ? { deadlineAt: sessionEntryDeadlineAt } : {}),
          });
          // Recovering 6h-abandoned calls (and retrying their digests) is not on the
          // start path; running it inline would delay use of time-sensitive provider
          // credentials behind slow channel sends. Fire it off the response path.
          void closeStaleClientVoiceSessions({
            agentId,
            config: runtimeConfig,
            excludeVoiceSessionId: normalizeOptionalString(typedParams.voiceSessionId),
            warn: (message) => context.logGateway.warn(`talk voice session recovery: ${message}`),
          }).catch((error: unknown) =>
            context.logGateway.warn(`talk voice session recovery failed: ${formatForLog(error)}`),
          );
          const connId = ownerConnId;
          const allocationId = connId ? browserSession.allocateBrowserAllocationId() : undefined;
          const voice = createOrResumeClientVoiceSessionWithResult({
            agentId,
            sessionKey,
            provider: resolution.provider.id,
            origin: "client",
            ...(allocationId ? { browserAllocationId: allocationId } : {}),
            // Deployed clients sent sessionKey before transcripts existed, so capability
            // must be negotiated explicitly; declaring it turns the confirmation gate on.
            transcriptCapable: typedParams.capabilities?.includes("voice-transcript") === true,
            voiceSessionId: normalizeOptionalString(typedParams.voiceSessionId),
            ...(creationLease ? { assertCommitAllowed: creationLease.assertActive } : {}),
          });
          const voiceSessionId = voice.voiceSessionId;
          activeVoiceSessionId = voiceSessionId;
          if (connId) {
            const identity = { agentId, sessionKey, voiceSessionId };
            const allocation = await browserSession.prepareBrowserAllocationForClient({
              ...identity,
              allocationId: allocationId!,
              expectedBrowserAllocationId: voice.created ? allocationId : voice.browserAllocationId,
              connId,
              durableState: voice.created ? "created" : "existing",
              usesBrowserAllocations,
              cancel: cancelSession,
              config: runtimeConfig,
              broadcast: context.broadcastToConnIds,
              warn: (message) => context.logGateway.warn(message),
            });
            creationLease?.assertActive();
            const now = Date.now();
            pruneLegacyVoiceBindings(now);
            legacyVoiceSessionByClient.set(
              legacyVoiceBindingKey(connId, typedParams.sessionKey?.trim() || sessionKey),
              { voiceSessionId, expiresAt: now + LEGACY_VOICE_BINDING_TTL_MS },
            );
            const allocationDetails = usesBrowserAllocations
              ? { allocationId: allocation.allocationId }
              : {};
            respond(true, { ...session, voiceSessionId, ...allocationDetails }, undefined);
            return;
          }
          respond(true, { ...session, voiceSessionId }, undefined);
          return;
        } catch (error) {
          await cancelSession();
          throw error;
        }
      }
      await cancelSession();
      if (transport) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `Realtime provider "${resolution.provider.id}" does not support requested browser transport "${transport}"`,
          ),
        );
        return;
      }
    }
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        `Realtime provider "${resolution.provider.id}" does not support client-owned realtime sessions`,
      ),
    );
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
  } finally {
    creationLease?.release();
  }
};
