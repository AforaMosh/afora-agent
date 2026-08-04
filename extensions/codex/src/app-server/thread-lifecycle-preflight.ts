import {
  embeddedAgentLog,
  formatErrorMessage,
  isHostScopedAgentToolActive,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildCodexUserMcpServersThreadConfigPatchForRuntime } from "openclaw/plugin-sdk/codex-mcp-projection";
import { getCodexAppServerClientInstanceId } from "./client.js";
import { isSystemAgentOnlyCodexDynamicToolAllowlist } from "./dynamic-tool-profile.js";
import { resolveCodexNativeSkillIsolation } from "./native-skill-isolation.js";
import { isCodexAppServerProfilerEnabled } from "./profiler-flag.js";
import { flattenCodexDynamicToolFunctions, isJsonObject } from "./protocol.js";
import { hashCodexAppServerBindingFingerprint } from "./session-binding.js";
import { buildContextEngineBinding } from "./thread-context-engine.js";
import {
  codexLegacyDynamicToolsFingerprint as legacyFingerprintDynamicTools,
  fingerprintEnvironmentSelection,
  fingerprintJsonObject,
  fingerprintUserMcpServersConfigPatch,
  legacyFingerprintUserMcpServersConfigPatch,
} from "./thread-fingerprints.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";
import {
  assertCodexRingZeroHasNoManagedHooks,
  buildCodexRingZeroThreadConfigPatch,
  buildCodexScheduledRuntimeAuthorityConfigPatch,
  CODEX_RING_ZERO_BASE_INSTRUCTIONS,
  readCodexInheritedMcpServerNames,
  readCodexInheritedMcpServerState,
} from "./thread-requests.js";
import { resolveCodexWebSearchPlan } from "./web-search.js";

export async function prepareCodexThreadLifecyclePreflight(params: CodexStartOrResumeThreadParams) {
  // Thread lifecycle spans are useful when profiling startup churn, but normal
  // turns should not pay Date.now/span-array overhead while resuming threads.
  const lifecycleTiming = createCodexThreadLifecycleTimingTracker({
    ...params.timing,
    enabled: params.timing?.enabled ?? isCodexAppServerProfilerEnabled(params.params.config),
  });
  const legacyDynamicToolsFingerprint = lifecycleTiming.measureSync(
    "legacy-dynamic-tools-fingerprint",
    () => legacyFingerprintDynamicTools(params.dynamicTools),
  );
  const dynamicToolsFingerprint = lifecycleTiming.measureSync("dynamic-tools-fingerprint", () =>
    hashCodexAppServerBindingFingerprint(legacyDynamicToolsFingerprint),
  );
  const dynamicToolsContainDeferred = flattenCodexDynamicToolFunctions(params.dynamicTools).some(
    (tool) => tool.deferLoading === true,
  );
  const webSearchPlan = lifecycleTiming.measureSync("web-search-plan", () =>
    resolveCodexWebSearchPlan({
      config: params.params.config,
      disableTools: params.params.disableTools,
      nativeToolSurfaceEnabled: params.nativeCodeModeEnabled,
      nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
      webSearchAllowed: params.webSearchAllowed,
    }),
  );
  const webSearchThreadConfigFingerprint = fingerprintJsonObject(webSearchPlan.threadConfig);
  const networkProxyConfigFingerprint = params.appServer.networkProxy?.configFingerprint;
  const contextEngineBinding = lifecycleTiming.measureSync("context-engine-binding", () =>
    buildContextEngineBinding(params.params, params.contextEngineProjection),
  );
  const userMcpServersConfigPatch =
    params.userMcpServersEnabled === false
      ? undefined
      : await buildCodexUserMcpServersThreadConfigPatchForRuntime(params.params.config, {
          agentId: params.agentId ?? params.params.agentId,
          agentDir: params.params.agentDir,
          allowLiteralOAuthProjection: params.appServer.connectionClass !== "remote",
          toolOverrides: params.params.toolOverrides,
          onServerUnavailable: (serverName, error) =>
            embeddedAgentLog.warn("skipping unavailable MCP OAuth server", {
              serverName,
              error: formatErrorMessage(error),
            }),
        });
  const nativeSkillIsolation = await lifecycleTiming.measure("native-skill-isolation", () =>
    resolveCodexNativeSkillIsolation({
      client: params.client,
      codexHome: params.appServer.start.env?.CODEX_HOME,
      cwd: params.cwd,
      home: params.appServer.start.env?.HOME,
      signal: params.signal,
      userProfile: params.appServer.start.env?.USERPROFILE,
    }),
  );
  const nativeSkillIsolationFingerprint = nativeSkillIsolation
    ? fingerprintJsonObject({
        version: 1,
        disabledUserSkillPaths: nativeSkillIsolation.disabledUserSkillPaths,
      })
    : undefined;
  const legacyUserMcpServersFingerprint =
    legacyFingerprintUserMcpServersConfigPatch(userMcpServersConfigPatch);
  const userMcpServersFingerprint = fingerprintUserMcpServersConfigPatch(userMcpServersConfigPatch);
  const environmentSelectionFingerprint = fingerprintEnvironmentSelection(
    params.environmentSelection,
  );
  const hostSystemAgentActive =
    params.hostSystemAgentActive ?? isHostScopedAgentToolActive("openclaw");
  const ringZeroActive =
    hostSystemAgentActive && isSystemAgentOnlyCodexDynamicToolAllowlist(params.params.toolsAllow);
  if (ringZeroActive && params.nativeCodeModeEnabled !== false) {
    throw new Error("Codex ring-zero requires native code mode to be disabled");
  }
  const ringZeroInheritedMcpServerNames = ringZeroActive
    ? await lifecycleTiming.measure("ring-zero-mcp-config-read", () =>
        readCodexInheritedMcpServerNames(params.client, params.cwd, params.signal),
      )
    : [];
  const scheduledRuntimeAuthority = params.params.scheduledRuntimeAuthority;
  if (scheduledRuntimeAuthority?.apps.length) {
    const installed = await params.client.request("app/installed", { forceRefresh: true });
    const callableAppIds = new Set(
      installed.apps.filter((app) => app.enabled && app.callable).map((app) => app.id),
    );
    const unavailableAppIds = scheduledRuntimeAuthority.apps
      .map((app) => app.appId)
      .filter((appId) => !callableAppIds.has(appId));
    if (unavailableAppIds.length > 0) {
      throw new Error(
        `Scheduled Codex app authority is no longer available for: ${unavailableAppIds.join(", ")}. Reconnect or re-enable the app, then explicitly reauthorize this automation.`,
      );
    }
  }
  const scheduledInheritedMcpServerState = scheduledRuntimeAuthority
    ? await lifecycleTiming.measure("scheduled-mcp-config-read", () =>
        readCodexInheritedMcpServerState(params.client, params.cwd, params.signal),
      )
    : { all: [], enabled: [], toolPolicies: {}, apps: undefined };
  if (scheduledRuntimeAuthority) {
    const enabledServers = new Set(scheduledInheritedMcpServerState.enabled);
    const unavailableServers = scheduledRuntimeAuthority.userMcpServers
      .map((server) => server.serverName)
      .filter((serverName) => !enabledServers.has(serverName));
    if (unavailableServers.length > 0) {
      throw new Error(
        `Scheduled Codex MCP authority is no longer available for: ${unavailableServers.join(", ")}. Restore the server, then explicitly reauthorize this automation.`,
      );
    }
  }
  const currentApps = isJsonObject(scheduledInheritedMcpServerState.apps)
    ? scheduledInheritedMcpServerState.apps
    : undefined;
  const appDefaults = isJsonObject(currentApps?.["_default"]) ? currentApps["_default"] : undefined;
  const effectiveScheduledRuntimeAuthority = scheduledRuntimeAuthority
    ? {
        ...scheduledRuntimeAuthority,
        apps: scheduledRuntimeAuthority.apps.map((app) => {
          const current = isJsonObject(currentApps?.[app.appId])
            ? currentApps[app.appId]
            : undefined;
          const currentDestructive =
            typeof current?.destructive_enabled === "boolean"
              ? current.destructive_enabled
              : typeof appDefaults?.destructive_enabled === "boolean"
                ? appDefaults.destructive_enabled
                : true;
          const currentOpenWorld =
            typeof current?.open_world_enabled === "boolean"
              ? current.open_world_enabled
              : typeof appDefaults?.open_world_enabled === "boolean"
                ? appDefaults.open_world_enabled
                : true;
          const currentApproval =
            current?.default_tools_approval_mode ?? appDefaults?.default_tools_approval_mode;
          return {
            ...app,
            allowDestructiveActions: app.allowDestructiveActions && currentDestructive,
            allowOpenWorld: app.allowOpenWorld && currentOpenWorld,
            approvalMode:
              app.approvalMode === "ask" ||
              currentApproval === "prompt" ||
              currentApproval === "writes"
                ? ("ask" as const)
                : app.approvalMode,
          };
        }),
        userMcpServers: scheduledRuntimeAuthority.userMcpServers.map((server) => {
          const currentPolicy = scheduledInheritedMcpServerState.toolPolicies[server.serverName];
          const enabled = currentPolicy?.enabled ? new Set(currentPolicy.enabled) : undefined;
          const disabled = new Set(currentPolicy?.disabled ?? []);
          return {
            ...server,
            toolNames: server.toolNames.filter(
              (toolName) => (!enabled || enabled.has(toolName)) && !disabled.has(toolName),
            ),
          };
        }),
      }
    : undefined;
  const fullyRevokedMcpServers = effectiveScheduledRuntimeAuthority?.userMcpServers
    .filter((server) => server.toolNames.length === 0)
    .map((server) => server.serverName);
  if (fullyRevokedMcpServers?.length) {
    throw new Error(
      `Scheduled Codex MCP authority no longer permits any captured tools for: ${fullyRevokedMcpServers.join(", ")}. Restore the tool policy, then explicitly reauthorize this automation.`,
    );
  }
  const scheduledRuntimeAuthorityConfigPatch = effectiveScheduledRuntimeAuthority
    ? buildCodexScheduledRuntimeAuthorityConfigPatch({
        authority: effectiveScheduledRuntimeAuthority,
        inheritedMcpServerNames: scheduledInheritedMcpServerState.all,
        inheritedApps: currentApps,
      })
    : undefined;
  const scheduledRuntimeAuthorityConfigFingerprint = scheduledRuntimeAuthorityConfigPatch
    ? fingerprintJsonObject({ version: 1, config: scheduledRuntimeAuthorityConfigPatch })
    : undefined;
  if (ringZeroActive) {
    await lifecycleTiming.measure("ring-zero-config-requirements-read", () =>
      assertCodexRingZeroHasNoManagedHooks(params.client, params.signal),
    );
  }
  const ringZeroConfigFingerprint = ringZeroActive
    ? fingerprintJsonObject({
        version: 1,
        baseInstructions: CODEX_RING_ZERO_BASE_INSTRUCTIONS,
        config: buildCodexRingZeroThreadConfigPatch(
          params.params,
          true,
          ringZeroInheritedMcpServerNames,
        )!,
      })
    : undefined;
  const ringZeroClientInstanceId = ringZeroActive
    ? getCodexAppServerClientInstanceId(params.client)
    : undefined;
  return {
    contextEngineBinding,
    scheduledRuntimeAuthorityConfigPatch,
    scheduledRuntimeAuthorityConfigFingerprint,
    dynamicToolsContainDeferred,
    dynamicToolsFingerprint,
    environmentSelectionFingerprint,
    hostSystemAgentActive,
    legacyDynamicToolsFingerprint,
    legacyUserMcpServersFingerprint,
    lifecycleTiming,
    nativeSkillIsolation,
    nativeSkillIsolationFingerprint,
    networkProxyConfigFingerprint,
    ringZeroActive,
    ringZeroClientInstanceId,
    ringZeroConfigFingerprint,
    ringZeroInheritedMcpServerNames,
    userMcpServersConfigPatch,
    userMcpServersFingerprint,
    webSearchThreadConfigFingerprint,
  };
}
