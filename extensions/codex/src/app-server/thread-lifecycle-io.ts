import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
} from "./attempt-client-cleanup.js";
import {
  type CodexAppServerClient,
  CodexAppServerRpcError,
  resolveCodexAppServerClientInstanceId,
} from "./client.js";
import { isMessageOnlyCodexSourceReply } from "./dynamic-tool-profile.js";
import { applyCodexNativeSkillIsolation } from "./native-skill-isolation.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import {
  attestCodexPluginThreadApps,
  discardUnattestedCodexPluginThread,
} from "./plugin-thread-attestation.js";
import { mergeCodexThreadConfigs, type CodexPluginThreadConfig } from "./plugin-thread-config.js";
import { assertCodexThreadStartResponse } from "./protocol-validators.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { fingerprintCodexThreadConfig } from "./thread-fingerprints.js";
import { retireLegacyMcpPredecessor } from "./thread-legacy-mcp-retirement.js";
import {
  CodexThreadBindingConflictError,
  CodexThreadStartRequestError,
} from "./thread-lifecycle-errors.js";
import {
  resolveCodexThreadRolloutPath,
  type ThreadRequestContext,
} from "./thread-lifecycle-resume.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
} from "./thread-lifecycle-types.js";
import { resolveCodexAppServerModelProvider } from "./thread-model-selection.js";
import {
  attestCodexRingZeroThreadHasNoMcpServers,
  buildThreadStartParams,
} from "./thread-requests.js";
import {
  readSupervisionResponseThreadId,
  requireDistinctSupervisionThreadId,
} from "./thread-supervision.js";

type StartThreadContext = ThreadRequestContext & {
  prebuiltPluginThreadConfig?: CodexPluginThreadConfig;
  preserveExistingBinding: boolean;
  rotatedContextEngineBinding: boolean;
  supervisionLegacyBinding?: CodexAppServerThreadBinding;
  ordinaryLegacyBinding?: CodexAppServerThreadBinding;
};

async function discardUncommittedSupervisionReplacement(params: {
  client: CodexAppServerClient;
  abandonClient?: () => Promise<void>;
  threadId: string;
  ephemeral: boolean;
  cause: unknown;
}): Promise<never> {
  if (
    await discardUnattestedCodexPluginThread({
      client: params.client,
      threadId: params.threadId,
      ephemeral: params.ephemeral,
    })
  ) {
    throw params.cause;
  }
  await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
  throw new CodexAppServerUnsafeSubscriptionError(
    `Codex supervised replacement cleanup failed: ${params.threadId}`,
    { cause: params.cause },
  );
}

export async function startFreshCodexThread(
  params: CodexStartOrResumeThreadParams,
  context: StartThreadContext,
): Promise<CodexAppServerThreadLifecycleBinding> {
  const clientId = resolveCodexAppServerClientInstanceId(params.client);
  const {
    bindingIdentity,
    startModelSelection,
    startModelProvider,
    dynamicToolsFingerprint,
    dynamicToolsContainDeferred,
    webSearchThreadConfigFingerprint,
    nativeSkillIsolationFingerprint,
    ringZeroConfigFingerprint,
    ringZeroClientInstanceId,
    networkProxyConfigFingerprint,
    contextEngineBinding,
    environmentSelectionFingerprint,
    hostSystemAgentActive,
    ringZeroActive,
    ringZeroInheritedMcpServerNames,
    nativeSkillIsolation,
    lifecycleTiming,
    normalizeBindingModelProvider,
    throwIfAborted,
    prebuiltPluginThreadConfig,
    preserveExistingBinding,
    rotatedContextEngineBinding,
    supervisionLegacyBinding,
    ordinaryLegacyBinding,
  } = context;
  const pluginThreadConfig = params.pluginThreadConfig?.enabled
    ? (prebuiltPluginThreadConfig ??
      (await lifecycleTiming.measure("plugin-config-build", () =>
        params.pluginThreadConfig?.build(),
      )))
    : undefined;
  const finalConfigPatch = params.buildFinalConfigPatch?.({ action: "start" }) ?? {
    configPatch: params.finalConfigPatch,
    nativeHookRelayGeneration: params.nativeHookRelayGeneration,
  };
  const config = lifecycleTiming.measureSync("merge-thread-config", () =>
    applyCodexNativeSkillIsolation(
      mergeCodexThreadConfigs(
        params.config,
        pluginThreadConfig?.configPatch,
        finalConfigPatch.configPatch,
      ),
      nativeSkillIsolation,
    ),
  );
  const supervisionOwner = supervisionLegacyBinding
    ? (() => {
        const model = supervisionLegacyBinding.model?.trim();
        const modelProvider = supervisionLegacyBinding.modelProvider?.trim();
        const sourceThreadId = supervisionLegacyBinding.supervisionSourceThreadId?.trim();
        if (
          supervisionLegacyBinding.connectionScope !== "supervision" ||
          supervisionLegacyBinding.preserveNativeModel !== true ||
          !model ||
          !modelProvider ||
          !sourceThreadId
        ) {
          throw new Error("Codex supervised replacement lost its native owner identity");
        }
        return { model, modelProvider, sourceThreadId };
      })()
    : undefined;
  const effectiveStartModelSelection = supervisionOwner
    ? {
        model: supervisionOwner.model,
        modelProvider: supervisionOwner.modelProvider,
      }
    : { model: startModelSelection.model, modelProvider: startModelProvider };
  const startParams = lifecycleTiming.measureSync("thread-start-params", () =>
    buildThreadStartParams(params.params, {
      cwd: params.cwd,
      dynamicTools: params.dynamicTools,
      appServer: params.appServer,
      developerInstructions: params.developerInstructions,
      config,
      nativeCodeModeEnabled: params.nativeCodeModeEnabled,
      nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
      nativeCodeModeOnlyEnabled: params.nativeCodeModeOnlyEnabled,
      webSearchAllowed: params.webSearchAllowed,
      environmentSelection: params.environmentSelection,
      model: effectiveStartModelSelection.model,
      modelProvider: effectiveStartModelSelection.modelProvider,
      hostSystemAgentActive,
      ringZeroInheritedMcpServerNames,
    }),
  );
  const requestModelProvider =
    typeof startParams.modelProvider === "string" && startParams.modelProvider.trim()
      ? startParams.modelProvider
      : undefined;
  const threadStartResponse = await lifecycleTiming.measure("thread-start-request", async () => {
    try {
      return await params.client.request("thread/start", startParams, { signal: params.signal });
    } catch (error) {
      if (error instanceof CodexAppServerRpcError) {
        throw new CodexThreadStartRequestError(error);
      }
      if (supervisionLegacyBinding) {
        await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
        throw new CodexAppServerUnsafeSubscriptionError(
          "Codex supervised MCP successor may have started without a response",
          { cause: error },
        );
      }
      throw error;
    }
  });
  let supervisionSuccessorThreadId: string | undefined;
  if (supervisionLegacyBinding && supervisionOwner) {
    try {
      supervisionSuccessorThreadId = requireDistinctSupervisionThreadId({
        threadId: readSupervisionResponseThreadId(threadStartResponse),
        sourceThreadId: supervisionOwner.sourceThreadId,
        otherThreadId: supervisionLegacyBinding.threadId,
        role: "configured MCP successor",
      });
    } catch (error) {
      await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
      throw error;
    }
  }
  let response: ReturnType<typeof assertCodexThreadStartResponse>;
  try {
    response = assertCodexThreadStartResponse(threadStartResponse);
  } catch (error) {
    if (supervisionSuccessorThreadId) {
      await discardUncommittedSupervisionReplacement({
        client: params.client,
        abandonClient: params.abandonClient,
        threadId: supervisionSuccessorThreadId,
        ephemeral: startParams.ephemeral === true,
        cause: error,
      });
    }
    throw error;
  }
  if (
    supervisionLegacyBinding &&
    (response.model !== effectiveStartModelSelection.model ||
      response.modelProvider !== effectiveStartModelSelection.modelProvider)
  ) {
    await discardUncommittedSupervisionReplacement({
      client: params.client,
      abandonClient: params.abandonClient,
      threadId: response.thread.id,
      ephemeral: startParams.ephemeral === true,
      cause: new Error("Codex supervised replacement changed its native model or provider"),
    });
  }
  const provisionalAppIds = pluginThreadConfig?.provisionalAppIds;
  // A deny-by-default app becomes callable only under this exact thread's
  // allowlist. Never persist or run the thread before Codex confirms it.
  if (provisionalAppIds?.length) {
    try {
      await lifecycleTiming.measure("plugin-app-attestation", () =>
        attestCodexPluginThreadApps({
          client: params.client,
          threadId: response.thread.id,
          appIds: provisionalAppIds,
          signal: params.signal,
        }),
      );
    } catch (error) {
      const cleanupConfirmed = await discardUnattestedCodexPluginThread({
        client: params.client,
        threadId: response.thread.id,
        ephemeral: startParams.ephemeral === true,
      });
      if (!cleanupConfirmed) {
        await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
        throw new CodexAppServerUnsafeSubscriptionError(
          "Codex plugin app attestation cleanup failed",
          { cause: error },
        );
      }
      throw error;
    }
  }
  const rolloutPath = resolveCodexThreadRolloutPath(response.thread);
  if (ringZeroActive || isMessageOnlyCodexSourceReply(params.params)) {
    try {
      await lifecycleTiming.measure("ring-zero-mcp-attestation", () =>
        attestCodexRingZeroThreadHasNoMcpServers(params.client, response.thread.id, params.signal),
      );
    } catch (error) {
      if (supervisionSuccessorThreadId) {
        await discardUncommittedSupervisionReplacement({
          client: params.client,
          abandonClient: params.abandonClient,
          threadId: supervisionSuccessorThreadId,
          ephemeral: startParams.ephemeral === true,
          cause: error,
        });
      }
      await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
      throw error;
    }
  }
  try {
    throwIfAborted();
  } catch (error) {
    if (supervisionSuccessorThreadId) {
      await discardUncommittedSupervisionReplacement({
        client: params.client,
        abandonClient: params.abandonClient,
        threadId: supervisionSuccessorThreadId,
        ephemeral: startParams.ephemeral === true,
        cause: error,
      });
    }
    throw error;
  }
  const modelProvider = resolveCodexAppServerModelProvider({
    provider: params.params.provider,
    authProfileId: params.params.authProfileId,
    authProfileStore: params.params.authProfileStore,
    agentDir: params.params.agentDir,
    config: params.params.config,
  });
  const bindingModelProvider =
    supervisionOwner?.modelProvider ??
    normalizeBindingModelProvider(
      params.params.authProfileId,
      response.modelProvider ?? requestModelProvider ?? startModelProvider ?? modelProvider,
    );
  let committedSupervisionBinding: CodexAppServerThreadBinding | undefined;
  if (supervisionLegacyBinding && supervisionOwner && !preserveExistingBinding) {
    const supervisionSourceThreadId = supervisionOwner.sourceThreadId;
    const replacementBinding: CodexAppServerThreadBinding = {
      threadId: response.thread.id,
      ...(clientId ? { clientId } : {}),
      cwd: params.cwd,
      ...(rolloutPath ? { rolloutPath } : {}),
      authProfileId: undefined,
      model: response.model,
      modelProvider: bindingModelProvider,
      preserveNativeModel: true,
      connectionScope: "supervision",
      supervisionSourceThreadId,
      conversationSourceTransferComplete: true,
      dynamicToolsFingerprint,
      dynamicToolsContainDeferred,
      webSearchThreadConfigFingerprint,
      nativeSkillIsolationFingerprint,
      ringZeroConfigFingerprint,
      ringZeroClientInstanceId,
      networkProxyProfileName: params.appServer.networkProxy?.profileName,
      networkProxyConfigFingerprint,
      nativeHookRelayGeneration: finalConfigPatch.nativeHookRelayGeneration,
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
        params.appServer,
        params.params.agentDir,
      ),
      pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
      pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
      pluginAppPolicyContext: pluginThreadConfig?.policyContext,
      contextEngine: contextEngineBinding,
      environmentSelectionFingerprint,
      legacyMcpRetirementThreadId: supervisionLegacyBinding.threadId,
    };
    committedSupervisionBinding = await params.bindingStore.withThreadArchiveFence(async () => {
      const hasOtherOwner = await (async () => {
        try {
          return (
            await params.bindingStore.inspectThreadOwnership(supervisionLegacyBinding.threadId, [
              bindingIdentity,
            ])
          ).hasUnexpectedOwner;
        } catch (error) {
          return await discardUncommittedSupervisionReplacement({
            client: params.client,
            abandonClient: params.abandonClient,
            threadId: replacementBinding.threadId,
            ephemeral: startParams.ephemeral === true,
            cause: error,
          });
        }
      })();
      if (hasOtherOwner) {
        await discardUncommittedSupervisionReplacement({
          client: params.client,
          abandonClient: params.abandonClient,
          threadId: replacementBinding.threadId,
          ephemeral: startParams.ephemeral === true,
          cause: new CodexThreadBindingConflictError(
            supervisionLegacyBinding.threadId,
            "retiring a legacy supervised MCP thread owned by another session",
          ),
        });
      }
      const matchesCommittedReplacement = (
        current: CodexAppServerThreadBinding | undefined,
      ): boolean =>
        current?.threadId === replacementBinding.threadId &&
        current.connectionScope === "supervision" &&
        current.supervisionSourceThreadId === supervisionSourceThreadId &&
        current.preserveNativeModel === true &&
        current.conversationSourceTransferComplete === true &&
        current.model === replacementBinding.model &&
        current.modelProvider === replacementBinding.modelProvider &&
        current.dynamicToolsFingerprint === dynamicToolsFingerprint &&
        current.legacyMcpRetirementThreadId === supervisionLegacyBinding.threadId &&
        current.historyCoveredThrough === undefined &&
        current.userMcpServersFingerprint === undefined &&
        current.mcpServersFingerprint === undefined;
      let committed = false;
      let commitError: unknown;
      try {
        committed = await lifecycleTiming.measure("thread-start-write-binding", () =>
          params.bindingStore.mutate(bindingIdentity, {
            kind: "replace-supervision-thread",
            expectedThreadId: supervisionLegacyBinding.threadId,
            expectedSupervisionSourceThreadId: supervisionSourceThreadId,
            binding: replacementBinding,
          }),
        );
      } catch (error) {
        commitError = error;
      }
      if (!committed) {
        let current: CodexAppServerThreadBinding | undefined;
        try {
          current = await params.bindingStore.read(bindingIdentity);
        } catch (readError) {
          await (
            params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client))
          )();
          throw new CodexAppServerUnsafeSubscriptionError(
            `Codex supervised replacement binding could not be verified: ${response.thread.id}`,
            { cause: new AggregateError([commitError, readError].filter(Boolean)) },
          );
        }
        if (!matchesCommittedReplacement(current)) {
          await discardUncommittedSupervisionReplacement({
            client: params.client,
            abandonClient: params.abandonClient,
            threadId: response.thread.id,
            ephemeral: startParams.ephemeral === true,
            cause:
              commitError ??
              new CodexThreadBindingConflictError(
                supervisionLegacyBinding.threadId,
                "committing a supervised configured MCP replacement",
              ),
          });
        }
      }
      await retireLegacyMcpPredecessor({
        client: params.client,
        bindingStore: params.bindingStore,
        bindingIdentity,
        threadId: supervisionLegacyBinding.threadId,
        retirementMode: "archive",
        signal: params.signal,
      });
      const retirementCommitted = await params.bindingStore.mutate(bindingIdentity, {
        kind: "complete-legacy-mcp-retirement",
        expectedThreadId: replacementBinding.threadId,
        expectedRetirementThreadId: supervisionLegacyBinding.threadId,
      });
      if (!retirementCommitted) {
        throw new CodexThreadBindingConflictError(
          replacementBinding.threadId,
          "completing supervised legacy MCP thread retirement",
        );
      }
      replacementBinding.legacyMcpRetirementThreadId = undefined;
      // Archiving keeps operator history while removing the retired native-MCP
      // thread from every OpenClaw catalog and resume path.
      return replacementBinding;
    });
  } else if (!preserveExistingBinding) {
    const freshBinding: CodexAppServerThreadBinding = {
      threadId: response.thread.id,
      ...(clientId ? { clientId } : {}),
      cwd: params.cwd,
      ...(rolloutPath ? { rolloutPath } : {}),
      authProfileId: params.params.authProfileId,
      model: response.model ?? startParams.model ?? params.params.modelId,
      modelProvider: bindingModelProvider,
      dynamicToolsFingerprint,
      dynamicToolsContainDeferred,
      webSearchThreadConfigFingerprint,
      nativeSkillIsolationFingerprint,
      ringZeroConfigFingerprint,
      ringZeroClientInstanceId,
      networkProxyProfileName: params.appServer.networkProxy?.profileName,
      networkProxyConfigFingerprint,
      nativeHookRelayGeneration: finalConfigPatch.nativeHookRelayGeneration,
      appServerRuntimeFingerprint: params.appServerRuntimeFingerprint,
      pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
      pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
      pluginAppPolicyContext: pluginThreadConfig?.policyContext,
      contextEngine: contextEngineBinding,
      environmentSelectionFingerprint,
      ...(ordinaryLegacyBinding
        ? { legacyMcpRetirementThreadId: ordinaryLegacyBinding.threadId }
        : {}),
    };
    const commitFreshBinding = async () => {
      if (ordinaryLegacyBinding) {
        const ownership = await (async () => {
          try {
            return await params.bindingStore.inspectThreadOwnership(
              ordinaryLegacyBinding.threadId,
              [bindingIdentity],
            );
          } catch (error) {
            return await discardUncommittedSupervisionReplacement({
              client: params.client,
              abandonClient: params.abandonClient,
              threadId: response.thread.id,
              ephemeral: startParams.ephemeral === true,
              cause: error,
            });
          }
        })();
        if (ownership.hasUnexpectedOwner) {
          await discardUncommittedSupervisionReplacement({
            client: params.client,
            abandonClient: params.abandonClient,
            threadId: response.thread.id,
            ephemeral: startParams.ephemeral === true,
            cause: new CodexThreadBindingConflictError(
              ordinaryLegacyBinding.threadId,
              "retiring an ordinary legacy MCP thread owned by another session",
            ),
          });
        }
      }
      const committed = await lifecycleTiming.measure("thread-start-write-binding", () =>
        params.bindingStore.mutate(bindingIdentity, {
          ...(ordinaryLegacyBinding
            ? {
                kind: "replace-legacy-mcp-thread" as const,
                expectedThreadId: ordinaryLegacyBinding.threadId,
              }
            : { kind: "set" as const, if: { kind: "absent" as const } }),
          binding: freshBinding,
        }),
      );
      if (!committed) {
        throw new CodexThreadBindingConflictError(response.thread.id, "committing a fresh thread");
      }
      if (!ordinaryLegacyBinding) {
        return;
      }
      await retireLegacyMcpPredecessor({
        client: params.client,
        bindingStore: params.bindingStore,
        bindingIdentity,
        threadId: ordinaryLegacyBinding.threadId,
        retirementMode: "preserve",
        signal: params.signal,
      });
      const retirementCommitted = await params.bindingStore.mutate(bindingIdentity, {
        kind: "complete-legacy-mcp-retirement",
        expectedThreadId: response.thread.id,
        expectedRetirementThreadId: ordinaryLegacyBinding.threadId,
      });
      if (!retirementCommitted) {
        throw new CodexThreadBindingConflictError(
          response.thread.id,
          "completing legacy MCP thread retirement",
        );
      }
      freshBinding.legacyMcpRetirementThreadId = undefined;
    };
    await params.bindingStore.withThreadArchiveFence(commitFreshBinding);
    if (contextEngineBinding) {
      embeddedAgentLog.info("codex app-server wrote context-engine thread binding", {
        sessionId: params.params.sessionId,
        sessionKey: params.params.sessionKey,
        threadId: response.thread.id,
        engineId: contextEngineBinding.engineId,
        epoch: contextEngineBinding.projection?.epoch,
        fingerprint: contextEngineBinding.projection?.fingerprint,
        action: rotatedContextEngineBinding ? "rotated" : "started",
      });
    }
  }
  lifecycleTiming.mark("thread-ready");
  lifecycleTiming.logSummary({
    runId: params.params.runId,
    sessionId: params.params.sessionId,
    sessionKey: params.params.sessionKey,
    threadId: response.thread.id,
    action: rotatedContextEngineBinding ? "rotated" : "started",
  });
  return {
    ...(committedSupervisionBinding ?? {
      threadId: response.thread.id,
      ...(clientId ? { clientId } : {}),
      cwd: params.cwd,
      ...(rolloutPath ? { rolloutPath } : {}),
      authProfileId: supervisionOwner ? undefined : params.params.authProfileId,
      model: response.model ?? startParams.model ?? params.params.modelId,
      modelProvider:
        response.modelProvider ?? requestModelProvider ?? startModelProvider ?? modelProvider,
      ...(supervisionOwner
        ? {
            connectionScope: "supervision" as const,
            supervisionSourceThreadId: supervisionOwner.sourceThreadId,
            preserveNativeModel: true as const,
            conversationSourceTransferComplete: true as const,
          }
        : {}),
      dynamicToolsFingerprint,
      dynamicToolsContainDeferred,
      nativeSkillIsolationFingerprint,
      ringZeroConfigFingerprint,
      ringZeroClientInstanceId,
      networkProxyProfileName: params.appServer.networkProxy?.profileName,
      networkProxyConfigFingerprint,
      nativeHookRelayGeneration: finalConfigPatch.nativeHookRelayGeneration,
      appServerRuntimeFingerprint: supervisionOwner
        ? buildCodexAppServerConnectionFingerprint(params.appServer, params.params.agentDir)
        : params.appServerRuntimeFingerprint,
      pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
      pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
      pluginAppPolicyContext: pluginThreadConfig?.policyContext,
      contextEngine: contextEngineBinding,
      environmentSelectionFingerprint,
      ...(ordinaryLegacyBinding && !preserveExistingBinding
        ? { legacyMcpRetirementThreadId: undefined }
        : {}),
    }),
    // Transient starts do not own the persisted binding, so their native
    // subscriptions must be released instead of entering the warm cache.
    ...(!preserveExistingBinding || committedSupervisionBinding
      ? {
          liveThreadConfigFingerprint: fingerprintCodexThreadConfig(
            {
              ...startParams,
              model: response.model ?? startParams.model ?? null,
              requestedModel: startParams.model ?? null,
              modelProvider: bindingModelProvider ?? null,
              requestedModelProvider: startParams.modelProvider ?? bindingModelProvider ?? null,
            },
            supervisionLegacyBinding ? undefined : params.params.authProfileId,
            dynamicToolsFingerprint,
          ),
        }
      : {}),
    lifecycle: {
      action: "started",
      ...(rotatedContextEngineBinding ? { rotatedContextEngineBinding } : {}),
    },
  };
}
