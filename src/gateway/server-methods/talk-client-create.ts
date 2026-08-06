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
import { createDeferred } from "../../shared/deferred.js";
import { consultRealtimeVoiceAgent } from "../../talk/agent-consult-runtime.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../../talk/agent-run-control-shared.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import {
  allocateClientVoiceSessionId,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
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

function createRealtimeConsultStartupGate() {
  let prepared = false;
  let settled: string | Error | undefined;
  let pending: ReturnType<typeof createDeferred<string | Error>> | undefined;
  return {
    prepare(): void {
      prepared = true;
    },
    activate(nextVoiceSessionId: string): void {
      if (settled instanceof Error) {
        throw new Error("Realtime browser voice session retired during startup");
      }
      settled = nextVoiceSessionId;
      pending?.resolve(nextVoiceSessionId);
    },
    retire(this: void): void {
      if (!(settled instanceof Error)) {
        settled = new Error("Realtime browser voice session retired before agent consult");
        pending?.resolve(settled);
      }
    },
    async admit(signal: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      if (settled) {
        if (settled instanceof Error) {
          throw settled;
        }
        return settled;
      }
      if (!prepared || pending) {
        const state = pending ? "already has a pending" : "is not ready for";
        throw new Error(`Realtime browser voice session ${state} agent consult`);
      }
      const waiter = (pending = createDeferred<string | Error>());
      const abort = () =>
        waiter.resolve(
          signal.reason instanceof Error ? signal.reason : new Error("agent consult aborted"),
        );
      signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await waiter.promise;
        if (result instanceof Error) {
          throw result;
        }
        return result;
      } finally {
        if (pending === waiter) {
          pending = undefined;
        }
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

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
      const consultGate = createRealtimeConsultStartupGate();
      const runAgentConsult: NonNullable<
        InternalRealtimeVoiceBrowserSessionCreateRequest["runAgentConsult"]
      > = async ({ prompt, signal }) => {
        const consultSignal = signal ?? new AbortController().signal;
        const voiceSessionId = await consultGate.admit(consultSignal);
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
          abortSignal: consultSignal,
          onRunStarted: ({ runId, sessionId, timeoutMs }) => {
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
      const terminal = browserSession.bindBrowserSessionTerminal(
        browserSessionRequest,
        consultGate.retire,
      );
      let canceling: Promise<void> | undefined;
      const session = await resolution.provider
        .createBrowserSession(browserSessionRequest)
        .catch((error: unknown) => {
          consultGate.retire();
          throw error;
        });
      const cancelSession = () => {
        consultGate.retire();
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
        // Relay sessions are minted elsewhere; widening this guard miskeys their voiceSessionId.
        if (
          (session.transport === "webrtc" || session.transport === "provider-websocket") &&
          !isUnsupportedBrowserWebRtcSession(session) &&
          (!transport || session.transport === transport)
        ) {
          const sessionEntryDeadlineAt =
            session.expiresAt === undefined
              ? undefined
              : session.expiresAt - REALTIME_VOICE_CLIENT_SESSION_MIN_TTL_MS;
          if (sessionEntryDeadlineAt !== undefined && Date.now() >= sessionEntryDeadlineAt) {
            throw new Error("Realtime browser session expired during startup; try again");
          }
          const voiceSessionId = allocateClientVoiceSessionId(
            normalizeOptionalString(typedParams.voiceSessionId),
          );
          consultGate.prepare();
          const connId = ownerConnId;
          const allocationId = connId ? browserSession.allocateBrowserAllocationId() : undefined;
          const allocationParams = connId
            ? {
                agentId,
                sessionKey,
                voiceSessionId,
                allocationId: allocationId!,
                connId,
                usesBrowserAllocations,
                cancel: cancelSession,
                activateEffects: () => consultGate.activate(voiceSessionId),
                retireEffects: consultGate.retire,
                config: runtimeConfig,
                broadcast: context.broadcastToConnIds,
                warn: (message: string) => context.logGateway.warn(message),
              }
            : undefined;
          const terminalPreparation = terminal.prepareTerminal(allocationParams);
          if (terminalPreparation) {
            const terminalAllocation = await terminalPreparation;
            creationLease?.assertActive();
            respond(true, { ...session, ...terminalAllocation }, undefined);
            return;
          }
          const voice = createOrResumeClientVoiceSession({
            agentId,
            sessionKey,
            provider: resolution.provider.id,
            origin: "client",
            ...(allocationId ? { browserAllocationId: allocationId } : {}),
            // Deployed clients sent sessionKey before transcripts existed, so capability
            // must be negotiated explicitly; declaring it turns the confirmation gate on.
            transcriptCapable: typedParams.capabilities?.includes("voice-transcript") === true,
            voiceSessionId,
            ...(creationLease ? { assertCommitAllowed: creationLease.assertActive } : {}),
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
          if (!allocationParams || !connId) {
            consultGate.activate(voice.voiceSessionId);
            respond(true, { ...session, voiceSessionId: voice.voiceSessionId }, undefined);
            return;
          }
          const allocation = await terminal.prepare({
            ...allocationParams,
            expectedBrowserAllocationId: voice.created ? allocationId : voice.browserAllocationId,
            durableState: voice.created ? "created" : "existing",
          });
          creationLease?.assertActive();
          browserSession.recordLegacyVoiceBinding(
            connId,
            typedParams.sessionKey?.trim() || sessionKey,
            voice.voiceSessionId,
          );
          const allocationDetails = usesBrowserAllocations
            ? { allocationId: allocation.allocationId, terminal: terminal.outcome() }
            : {};
          respond(
            true,
            { ...session, voiceSessionId: voice.voiceSessionId, ...allocationDetails },
            undefined,
          );
          return;
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
      } catch (error) {
        await cancelSession();
        throw error;
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
