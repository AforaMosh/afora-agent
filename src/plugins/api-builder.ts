// Builds plugin API objects from config, registries, and runtime helpers.
import type { AforaConfig } from "../config/types.afora.js";
import { attachPluginApiFacades, type AforaPluginApiWithoutFacades } from "./api-facades.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { AforaPluginApi, PluginLogger } from "./types.js";

type BuildPluginApiParams = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  rootDir?: string;
  registrationMode: AforaPluginApi["registrationMode"];
  config: AforaConfig;
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;
  resolvePath: (input: string) => string;
  handlers?: Partial<
    Pick<
      AforaPluginApi,
      | "registerTool"
      | "registerHook"
      | "registerHttpRoute"
      | "registerHostedMediaResolver"
      | "registerMcpServerConnectionResolver"
      | "registerChannel"
      | "registerGatewayMethod"
      | "registerSessionCatalog"
      | "registerCli"
      | "registerReload"
      | "registerNodeHostCommand"
      | "registerNodeInvokePolicy"
      | "registerSecurityAuditCollector"
      | "registerService"
      | "registerGatewayDiscoveryService"
      | "registerCliBackend"
      | "registerTextTransforms"
      | "registerConfigMigration"
      | "registerMigrationProvider"
      | "registerAutoEnableProbe"
      | "registerProvider"
      | "registerWorkerProvider"
      | "registerModelCatalogProvider"
      | "registerEmbeddingProvider"
      | "registerSpeechProvider"
      | "registerRealtimeTranscriptionProvider"
      | "registerRealtimeVoiceProvider"
      | "registerMediaUnderstandingProvider"
      | "registerTranscriptSourceProvider"
      | "registerImageGenerationProvider"
      | "registerVideoGenerationProvider"
      | "registerMusicGenerationProvider"
      | "registerWebFetchProvider"
      | "registerWebSearchProvider"
      | "registerInteractiveHandler"
      | "onConversationBindingResolved"
      | "registerCommand"
      | "registerContextEngine"
      | "registerCompactionProvider"
      | "registerAgentHarness"
      | "registerCodexAppServerExtensionFactory"
      | "registerAgentToolResultMiddleware"
      | "registerSessionExtension"
      | "enqueueNextTurnInjection"
      | "registerTrustedToolPolicy"
      | "registerToolMetadata"
      | "registerControlUiDescriptor"
      | "registerRuntimeLifecycle"
      | "registerAgentEventSubscription"
      | "emitAgentEvent"
      | "setRunContext"
      | "getRunContext"
      | "clearRunContext"
      | "registerSessionSchedulerJob"
      | "registerSessionAction"
      | "sendSessionAttachment"
      | "scheduleSessionTurn"
      | "unscheduleSessionTurnsByTag"
      | "registerDetachedTaskRuntime"
      | "registerMemoryCapability"
      | "registerMemoryPromptSupplement"
      | "registerMemoryPromptPreparation"
      | "registerMemoryCorpusSupplement"
      | "on"
    >
  >;
};

const noopRegisterTool: AforaPluginApi["registerTool"] = () => {};
const noopRegisterHook: AforaPluginApi["registerHook"] = () => {};
const noopRegisterHttpRoute: AforaPluginApi["registerHttpRoute"] = () => {};
const noopRegisterHostedMediaResolver: AforaPluginApi["registerHostedMediaResolver"] = () => {};
const noopRegisterMcpServerConnectionResolver: AforaPluginApi["registerMcpServerConnectionResolver"] =
  () => {};
const noopRegisterChannel: AforaPluginApi["registerChannel"] = () => {};
const noopRegisterGatewayMethod: AforaPluginApi["registerGatewayMethod"] = () => {};
const noopRegisterSessionCatalog: AforaPluginApi["registerSessionCatalog"] = () => {};
const noopRegisterCli: AforaPluginApi["registerCli"] = () => {};
const noopRegisterReload: AforaPluginApi["registerReload"] = () => {};
const noopRegisterNodeHostCommand: AforaPluginApi["registerNodeHostCommand"] = () => {};
const noopRegisterNodeInvokePolicy: AforaPluginApi["registerNodeInvokePolicy"] = () => {};
const noopRegisterSecurityAuditCollector: AforaPluginApi["registerSecurityAuditCollector"] =
  () => {};
const noopRegisterService: AforaPluginApi["registerService"] = () => {};
const noopRegisterGatewayDiscoveryService: AforaPluginApi["registerGatewayDiscoveryService"] =
  () => {};
const noopRegisterCliBackend: AforaPluginApi["registerCliBackend"] = () => {};
const noopRegisterTextTransforms: AforaPluginApi["registerTextTransforms"] = () => {};
const noopRegisterConfigMigration: AforaPluginApi["registerConfigMigration"] = () => {};
const noopRegisterMigrationProvider: AforaPluginApi["registerMigrationProvider"] = () => {};
const noopRegisterAutoEnableProbe: AforaPluginApi["registerAutoEnableProbe"] = () => {};
const noopRegisterProvider: AforaPluginApi["registerProvider"] = () => {};
const noopRegisterWorkerProvider: AforaPluginApi["registerWorkerProvider"] = () => {};
const noopRegisterModelCatalogProvider: AforaPluginApi["registerModelCatalogProvider"] =
  () => {};
const noopRegisterEmbeddingProvider: AforaPluginApi["registerEmbeddingProvider"] = () => {};
const noopRegisterSpeechProvider: AforaPluginApi["registerSpeechProvider"] = () => {};
const noopRegisterRealtimeTranscriptionProvider: AforaPluginApi["registerRealtimeTranscriptionProvider"] =
  () => {};
const noopRegisterRealtimeVoiceProvider: AforaPluginApi["registerRealtimeVoiceProvider"] =
  () => {};
const noopRegisterMediaUnderstandingProvider: AforaPluginApi["registerMediaUnderstandingProvider"] =
  () => {};
const noopRegisterTranscriptsSourceProvider: AforaPluginApi["registerTranscriptSourceProvider"] =
  () => {};
const noopRegisterImageGenerationProvider: AforaPluginApi["registerImageGenerationProvider"] =
  () => {};
const noopRegisterVideoGenerationProvider: AforaPluginApi["registerVideoGenerationProvider"] =
  () => {};
const noopRegisterMusicGenerationProvider: AforaPluginApi["registerMusicGenerationProvider"] =
  () => {};
const noopRegisterWebFetchProvider: AforaPluginApi["registerWebFetchProvider"] = () => {};
const noopRegisterWebSearchProvider: AforaPluginApi["registerWebSearchProvider"] = () => {};
const noopRegisterInteractiveHandler: AforaPluginApi["registerInteractiveHandler"] = () => {};
const noopOnConversationBindingResolved: AforaPluginApi["onConversationBindingResolved"] =
  () => {};
const noopRegisterCommand: AforaPluginApi["registerCommand"] = () => {};
const noopRegisterContextEngine: AforaPluginApi["registerContextEngine"] = () => {};
const noopRegisterCompactionProvider: AforaPluginApi["registerCompactionProvider"] = () => {};
const noopRegisterAgentHarness: AforaPluginApi["registerAgentHarness"] = () => {};
const noopRegisterCodexAppServerExtensionFactory: AforaPluginApi["registerCodexAppServerExtensionFactory"] =
  () => {};
const noopRegisterAgentToolResultMiddleware: AforaPluginApi["registerAgentToolResultMiddleware"] =
  () => {};
const noopRegisterSessionExtension: AforaPluginApi["registerSessionExtension"] = () => {};
const noopEnqueueNextTurnInjection: AforaPluginApi["enqueueNextTurnInjection"] = async (
  injection,
) => ({ enqueued: false, id: "", sessionKey: injection.sessionKey });
const noopRegisterTrustedToolPolicy: AforaPluginApi["registerTrustedToolPolicy"] = () => {};
const noopRegisterToolMetadata: AforaPluginApi["registerToolMetadata"] = () => {};
const noopRegisterControlUiDescriptor: AforaPluginApi["registerControlUiDescriptor"] = () => {};
const noopRegisterRuntimeLifecycle: AforaPluginApi["registerRuntimeLifecycle"] = () => {};
const noopRegisterAgentEventSubscription: AforaPluginApi["registerAgentEventSubscription"] =
  () => {};
const noopEmitAgentEvent: AforaPluginApi["emitAgentEvent"] = () => ({
  emitted: false,
  reason: "not wired",
});
const noopSetRunContext: AforaPluginApi["setRunContext"] = () => false;
const noopGetRunContext: AforaPluginApi["getRunContext"] = () => undefined;
const noopClearRunContext: AforaPluginApi["clearRunContext"] = () => {};
const noopRegisterSessionSchedulerJob: AforaPluginApi["registerSessionSchedulerJob"] = () =>
  undefined;
const noopRegisterSessionAction: AforaPluginApi["registerSessionAction"] = () => {};
const noopSendSessionAttachment: AforaPluginApi["sendSessionAttachment"] = async () => ({
  ok: false,
  error: "not wired",
});
const noopScheduleSessionTurn: AforaPluginApi["scheduleSessionTurn"] = async () => undefined;
const noopUnscheduleSessionTurnsByTag: AforaPluginApi["unscheduleSessionTurnsByTag"] =
  async () => ({ removed: 0, failed: 0 });
const noopRegisterDetachedTaskRuntime: AforaPluginApi["registerDetachedTaskRuntime"] = () => {};
const noopRegisterMemoryCapability: AforaPluginApi["registerMemoryCapability"] = () => {};
const noopRegisterMemoryPromptSupplement: AforaPluginApi["registerMemoryPromptSupplement"] =
  () => {};
const noopRegisterMemoryPromptPreparation: AforaPluginApi["registerMemoryPromptPreparation"] =
  () => {};
const noopRegisterMemoryCorpusSupplement: AforaPluginApi["registerMemoryCorpusSupplement"] =
  () => {};
const noopOn: AforaPluginApi["on"] = () => {};

export function buildPluginApi(params: BuildPluginApiParams): AforaPluginApi {
  const handlers = params.handlers ?? {};
  const registerCli = handlers.registerCli ?? noopRegisterCli;
  const api: AforaPluginApiWithoutFacades = {
    id: params.id,
    name: params.name,
    version: params.version,
    description: params.description,
    source: params.source,
    rootDir: params.rootDir,
    registrationMode: params.registrationMode,
    config: params.config,
    pluginConfig: params.pluginConfig,
    runtime: params.runtime,
    logger: params.logger,
    registerTool: handlers.registerTool ?? noopRegisterTool,
    registerHook: handlers.registerHook ?? noopRegisterHook,
    registerHttpRoute: handlers.registerHttpRoute ?? noopRegisterHttpRoute,
    registerHostedMediaResolver:
      handlers.registerHostedMediaResolver ?? noopRegisterHostedMediaResolver,
    registerMcpServerConnectionResolver:
      handlers.registerMcpServerConnectionResolver ?? noopRegisterMcpServerConnectionResolver,
    registerChannel: handlers.registerChannel ?? noopRegisterChannel,
    registerGatewayMethod: handlers.registerGatewayMethod ?? noopRegisterGatewayMethod,
    registerSessionCatalog: handlers.registerSessionCatalog ?? noopRegisterSessionCatalog,
    registerCli,
    registerNodeCliFeature: (registrar, opts) =>
      registerCli(registrar, {
        ...opts,
        parentPath: ["nodes"],
      }),
    registerReload: handlers.registerReload ?? noopRegisterReload,
    registerNodeHostCommand: handlers.registerNodeHostCommand ?? noopRegisterNodeHostCommand,
    registerNodeInvokePolicy: handlers.registerNodeInvokePolicy ?? noopRegisterNodeInvokePolicy,
    registerSecurityAuditCollector:
      handlers.registerSecurityAuditCollector ?? noopRegisterSecurityAuditCollector,
    registerService: handlers.registerService ?? noopRegisterService,
    registerGatewayDiscoveryService:
      handlers.registerGatewayDiscoveryService ?? noopRegisterGatewayDiscoveryService,
    registerCliBackend: handlers.registerCliBackend ?? noopRegisterCliBackend,
    registerTextTransforms: handlers.registerTextTransforms ?? noopRegisterTextTransforms,
    registerConfigMigration: handlers.registerConfigMigration ?? noopRegisterConfigMigration,
    registerMigrationProvider: handlers.registerMigrationProvider ?? noopRegisterMigrationProvider,
    registerAutoEnableProbe: handlers.registerAutoEnableProbe ?? noopRegisterAutoEnableProbe,
    registerProvider: handlers.registerProvider ?? noopRegisterProvider,
    registerWorkerProvider: handlers.registerWorkerProvider ?? noopRegisterWorkerProvider,
    registerModelCatalogProvider:
      handlers.registerModelCatalogProvider ?? noopRegisterModelCatalogProvider,
    registerEmbeddingProvider: handlers.registerEmbeddingProvider ?? noopRegisterEmbeddingProvider,
    registerSpeechProvider: handlers.registerSpeechProvider ?? noopRegisterSpeechProvider,
    registerRealtimeTranscriptionProvider:
      handlers.registerRealtimeTranscriptionProvider ?? noopRegisterRealtimeTranscriptionProvider,
    registerRealtimeVoiceProvider:
      handlers.registerRealtimeVoiceProvider ?? noopRegisterRealtimeVoiceProvider,
    registerMediaUnderstandingProvider:
      handlers.registerMediaUnderstandingProvider ?? noopRegisterMediaUnderstandingProvider,
    registerTranscriptSourceProvider:
      handlers.registerTranscriptSourceProvider ?? noopRegisterTranscriptsSourceProvider,
    registerImageGenerationProvider:
      handlers.registerImageGenerationProvider ?? noopRegisterImageGenerationProvider,
    registerVideoGenerationProvider:
      handlers.registerVideoGenerationProvider ?? noopRegisterVideoGenerationProvider,
    registerMusicGenerationProvider:
      handlers.registerMusicGenerationProvider ?? noopRegisterMusicGenerationProvider,
    registerWebFetchProvider: handlers.registerWebFetchProvider ?? noopRegisterWebFetchProvider,
    registerWebSearchProvider: handlers.registerWebSearchProvider ?? noopRegisterWebSearchProvider,
    registerInteractiveHandler:
      handlers.registerInteractiveHandler ?? noopRegisterInteractiveHandler,
    onConversationBindingResolved:
      handlers.onConversationBindingResolved ?? noopOnConversationBindingResolved,
    registerCommand: handlers.registerCommand ?? noopRegisterCommand,
    registerContextEngine: handlers.registerContextEngine ?? noopRegisterContextEngine,
    registerCompactionProvider:
      handlers.registerCompactionProvider ?? noopRegisterCompactionProvider,
    registerAgentHarness: handlers.registerAgentHarness ?? noopRegisterAgentHarness,
    registerCodexAppServerExtensionFactory:
      handlers.registerCodexAppServerExtensionFactory ?? noopRegisterCodexAppServerExtensionFactory,
    registerAgentToolResultMiddleware:
      handlers.registerAgentToolResultMiddleware ?? noopRegisterAgentToolResultMiddleware,
    registerSessionExtension: handlers.registerSessionExtension ?? noopRegisterSessionExtension,
    enqueueNextTurnInjection: handlers.enqueueNextTurnInjection ?? noopEnqueueNextTurnInjection,
    registerTrustedToolPolicy: handlers.registerTrustedToolPolicy ?? noopRegisterTrustedToolPolicy,
    registerToolMetadata: handlers.registerToolMetadata ?? noopRegisterToolMetadata,
    registerControlUiDescriptor:
      handlers.registerControlUiDescriptor ?? noopRegisterControlUiDescriptor,
    registerRuntimeLifecycle: handlers.registerRuntimeLifecycle ?? noopRegisterRuntimeLifecycle,
    registerAgentEventSubscription:
      handlers.registerAgentEventSubscription ?? noopRegisterAgentEventSubscription,
    emitAgentEvent: handlers.emitAgentEvent ?? noopEmitAgentEvent,
    setRunContext: handlers.setRunContext ?? noopSetRunContext,
    getRunContext: handlers.getRunContext ?? noopGetRunContext,
    clearRunContext: handlers.clearRunContext ?? noopClearRunContext,
    registerSessionSchedulerJob:
      handlers.registerSessionSchedulerJob ?? noopRegisterSessionSchedulerJob,
    registerSessionAction: handlers.registerSessionAction ?? noopRegisterSessionAction,
    sendSessionAttachment: handlers.sendSessionAttachment ?? noopSendSessionAttachment,
    scheduleSessionTurn: handlers.scheduleSessionTurn ?? noopScheduleSessionTurn,
    unscheduleSessionTurnsByTag:
      handlers.unscheduleSessionTurnsByTag ?? noopUnscheduleSessionTurnsByTag,
    registerDetachedTaskRuntime:
      handlers.registerDetachedTaskRuntime ?? noopRegisterDetachedTaskRuntime,
    registerMemoryCapability: handlers.registerMemoryCapability ?? noopRegisterMemoryCapability,
    registerMemoryPromptSupplement:
      handlers.registerMemoryPromptSupplement ?? noopRegisterMemoryPromptSupplement,
    registerMemoryPromptPreparation:
      handlers.registerMemoryPromptPreparation ?? noopRegisterMemoryPromptPreparation,
    registerMemoryCorpusSupplement:
      handlers.registerMemoryCorpusSupplement ?? noopRegisterMemoryCorpusSupplement,
    resolvePath: params.resolvePath,
    on: handlers.on ?? noopOn,
  };
  return attachPluginApiFacades(api);
}
