// Plugin entry contracts define the manifest-facing hooks implemented by plugin packages.
import { emptyPluginConfigSchema } from "../plugins/config-schema.js";
import type {
  AforaPluginConfigSchema,
  AforaPluginDefinition,
  ProviderBuiltInModelSuppressionContext as ProviderBuiltInModelSuppressionContextType,
} from "../plugins/types.js";
import { createCachedLazyValueGetter } from "./lazy-value.js";
export type { AforaConfig } from "../config/types.afora.js";

export type {
  AgentHarness,
  AgentPromptGuidance,
  AgentPromptGuidanceEntry,
  AgentPromptSurfaceKind,
  AnyAgentTool,
  MediaUnderstandingProviderPlugin,
  MigrationApplyResult,
  MigrationDetection,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
  MigrationSummary,
  AforaGatewayDiscoveryAdvertiseContext,
  AforaGatewayDiscoveryService,
  AforaPluginApi,
  AforaPluginCommandDefinition,
  AforaPluginConfigSchema,
  AforaPluginDefinition,
  AforaPluginHttpRouteHandler,
  AforaPluginNodeHostCommand,
  AforaPluginNodeHostCommandAvailabilityContext,
  AforaPluginNodeInvokePolicy,
  AforaPluginNodeInvokePolicyContext,
  AforaPluginNodeInvokePolicyResult,
  AforaPluginReloadRegistration,
  AforaPluginSecurityAuditCollector,
  AforaPluginSecurityAuditContext,
  AforaPluginService,
  AforaPluginServiceContext,
  AforaPluginToolContext,
  AforaPluginToolFactory,
  PluginAgentEventEmitParams,
  PluginAgentEventEmitResult,
  PluginAgentEventSubscriptionRegistration,
  PluginAgentTurnPrepareEvent,
  PluginAgentTurnPrepareResult,
  PluginCommandContext,
  PluginCommandResult,
  PluginControlUiDescriptor,
  PluginHeartbeatPromptContributionEvent,
  PluginHeartbeatPromptContributionResult,
  PluginJsonValue,
  PluginLogger,
  PluginNextTurnInjection,
  PluginNextTurnInjectionEnqueueResult,
  PluginNextTurnInjectionRecord,
  PluginRunContextGetParams,
  PluginRunContextPatch,
  PluginRuntimeLifecycleRegistration,
  PluginSessionActionContext,
  PluginSessionActionRegistration,
  PluginSessionActionResult,
  PluginSessionAttachmentParams,
  PluginSessionAttachmentResult,
  PluginSessionExtensionProjection,
  PluginSessionExtensionRegistration,
  PluginSessionSchedulerJobHandle,
  PluginSessionSchedulerJobRegistration,
  PluginSessionTurnScheduleParams,
  PluginSessionTurnUnscheduleByTagParams,
  PluginSessionTurnUnscheduleByTagResult,
  PluginToolMetadataRegistration,
  PluginTrustedToolPolicyRegistration,
  ProviderApplyConfigDefaultsContext,
  ProviderAugmentModelCatalogContext,
  ProviderAppGuidedSetup,
  ProviderAppGuidedSetupCandidate,
  ProviderAppGuidedSetupContext,
  ProviderAuthContext,
  ProviderAuthDoctorHintContext,
  ProviderAuthMethod,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
  ProviderBuildMissingAuthMessageContext,
  ProviderBuildUnknownModelHintContext,
  ProviderBuiltInModelSuppressionResult,
  ProviderCacheTtlEligibilityContext,
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderDefaultThinkingPolicyContext,
  ProviderDeferSyntheticProfileAuthContext,
  ProviderFailoverErrorContext,
  ProviderFetchUsageSnapshotContext,
  ProviderModernModelPolicyContext,
  ProviderNormalizeConfigContext,
  ProviderNormalizeModelIdContext,
  ProviderNormalizeResolvedModelContext,
  ProviderNormalizeToolSchemasContext,
  ProviderNormalizeTransportContext,
  // The plugin-authoring scaffold imports ProviderPlugin from this entrypoint.
  ProviderPlugin,
  ProviderPrepareDynamicModelContext,
  ProviderPrepareExtraParamsContext,
  ProviderPrepareRuntimeAuthContext,
  ProviderPreparedRuntimeAuth,
  ProviderReasoningOutputMode,
  ProviderReasoningOutputModeContext,
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
  ProviderReplaySessionEntry,
  ProviderReplaySessionState,
  ProviderResolveConfigApiKeyContext,
  ProviderResolveDynamicModelContext,
  ProviderResolveTransportTurnStateContext,
  ProviderResolveUsageAuthContext,
  ProviderResolveWebSocketSessionPolicyContext,
  ProviderResolvedUsageAuth,
  ProviderSanitizeReplayHistoryContext,
  ProviderThinkingPolicyContext,
  ProviderThinkingProfile,
  ProviderToolSchemaDiagnostic,
  ProviderTransportTurnState,
  ProviderUsageAuthToken,
  ProviderValidateReplayTurnsContext,
  ProviderWebSocketSessionPolicy,
  ProviderWrapStreamFnContext,
  RealtimeTranscriptionProviderPlugin,
  SpeechProviderPlugin,
  TranscriptSourceProvider,
  UnifiedModelCatalogProviderContext,
  UnifiedModelCatalogProviderPlugin,
  WorkerDesktopApp,
  WorkerDesktopEndpoint,
  WorkerLease,
  WorkerLeaseStatus,
  WorkerMachineOption,
  WorkerProfile,
  WorkerProvider,
  WorkerSshEndpoint,
  WorkerSshIdentity,
  WorkerSshIdentityRequest,
} from "../plugins/types.js";

// A direct re-export would inherit upstream @deprecated metadata, while this
// entrypoint's established surface exposes the same type without deprecating it.
export type ProviderBuiltInModelSuppressionContext = ProviderBuiltInModelSuppressionContextType;

export type {
  AforaPluginGatewayEventScope,
  AforaPluginGatewayEvents,
} from "../plugins/gateway-events.js";
export { WorkerProviderError } from "../plugins/capability-provider.types.js";

export type {
  PluginConversationBinding,
  PluginConversationBindingResolvedEvent,
  PluginConversationBindingRequestParams,
  PluginConversationBindingRequestResult,
} from "../plugins/conversation-binding.types.js";
export type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookInboundClaimResult,
  PluginHookInboundMessageMetadata,
  PluginHookLocation,
  PluginHookMediaFact,
  PluginHookMessageReceivedEvent,
  PluginHookProviderUpdate,
  PluginHookSkillArtifact,
  PluginHookSkillBundleFile,
  PluginHookSkillBundleSnapshot,
  PluginHookSkillChangedEvent,
  PluginHookSkillContext,
  PluginHookSkillEvaluationFinding,
  PluginHookSkillProposalChangedEvent,
  PluginHookSkillProposalEvaluateEvent,
  PluginHookSkillProposalEvaluateResult,
  PluginHookSkillProposalEvaluationOutcome,
  PluginHookSkillProposalKind,
} from "../plugins/hook-types.js";
export type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
export type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogKind,
  UnifiedModelCatalogSource,
} from "@afora/model-catalog-core/model-catalog-types";

export {
  buildJsonPluginConfigSchema,
  buildPluginConfigSchema,
  emptyPluginConfigSchema,
} from "../plugins/config-schema.js";

/** Options for a plugin entry that registers providers, tools, commands, or services. */
type DefinePluginEntryOptions = {
  id: string;
  name: string;
  description: string;
  /**
   * @deprecated Declare exclusive plugin kind in `afora.plugin.json` via
   * manifest `kind`. Runtime-entry `kind` remains only as a compatibility
   * fallback for older plugins.
   */
  kind?: AforaPluginDefinition["kind"];
  configSchema?: AforaPluginConfigSchema | (() => AforaPluginConfigSchema);
  reload?: AforaPluginDefinition["reload"];
  nodeHostCommands?: AforaPluginDefinition["nodeHostCommands"];
  securityAuditCollectors?: AforaPluginDefinition["securityAuditCollectors"];
  register: NonNullable<AforaPluginDefinition["register"]>;
};

/** Normalized object shape that Afora loads from a plugin entry module. */
type DefinedPluginEntry = Omit<DefinePluginEntryOptions, "configSchema"> & {
  configSchema: AforaPluginConfigSchema;
};

/**
 * Canonical entry helper for non-channel plugins.
 *
 * Use this for provider, tool, command, service, memory, and context-engine
 * plugins. Channel plugins should use `defineChannelPluginEntry(...)` from
 * `afora-agent/plugin-sdk/core` so they inherit the channel capability wiring.
 */
export function definePluginEntry({
  id,
  name,
  description,
  kind,
  configSchema = emptyPluginConfigSchema,
  reload,
  nodeHostCommands,
  securityAuditCollectors,
  register,
}: DefinePluginEntryOptions): DefinedPluginEntry {
  const getConfigSchema = createCachedLazyValueGetter(configSchema);
  return {
    id,
    name,
    description,
    ...(kind ? { kind } : {}),
    ...(reload ? { reload } : {}),
    ...(nodeHostCommands ? { nodeHostCommands } : {}),
    ...(securityAuditCollectors ? { securityAuditCollectors } : {}),
    get configSchema() {
      return getConfigSchema();
    },
    register,
  };
}
