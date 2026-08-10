// Handles abort requests and active reply run cancellation.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  abortEmbeddedAgentRun,
  resolveActiveEmbeddedRunIdentity,
  resolveActiveEmbeddedRunSessionId,
} from "../../agents/embedded-agent-runner/runs.js";
import type { MainSessionRecoveryRunIdentity } from "../../agents/main-session-recovery-types.js";
import { killControlledSubagentRun } from "../../agents/subagent-control.js";
import {
  getLatestSubagentRunByChildSessionKey,
  listSubagentRunsForController,
} from "../../agents/subagent-registry.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import { resolveStorePath } from "../../config/sessions.js";
import {
  loadSessionEntry,
  markSessionAbortTarget,
  resolveSessionAbortTarget,
  type SessionAbortTargetContext,
  type SessionAbortTargetIdentity,
  type SessionAbortTargetResult,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isAcpSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import {
  type AbortCutoff,
  resolveAbortCutoffFromContext,
  shouldPersistAbortCutoff,
} from "./abort-cutoff.js";
import { isAbortRequestText, isAbortTrigger, setAbortMemory } from "./abort-primitives.js";
import { resolveEffectiveResetTargetSessionKey } from "./acp-reset-target.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { clearSessionQueues } from "./queue.js";
import { runReplyRecoveryUserAbort } from "./reply-recovery-owner.js";
import { replyRunRegistry } from "./reply-run-registry.js";

export { isAbortRequestText, isAbortTrigger, setAbortMemory };

const defaultAbortDeps = {
  getAcpSessionManager,
  abortEmbeddedAgentRun,
  resolveActiveEmbeddedRunIdentity,
  resolveActiveEmbeddedRunSessionId,
  markSessionAbortTarget,
  resolveSessionAbortTarget,
  getLatestSubagentRunByChildSessionKey,
  listSubagentRunsForController,
  killControlledSubagentRun,
};

const abortDeps = {
  ...defaultAbortDeps,
};

const abortTestApi = {
  setDepsForTests(deps: Partial<typeof defaultAbortDeps> | undefined): void {
    abortDeps.getAcpSessionManager =
      deps?.getAcpSessionManager ?? defaultAbortDeps.getAcpSessionManager;
    abortDeps.abortEmbeddedAgentRun =
      deps?.abortEmbeddedAgentRun ?? defaultAbortDeps.abortEmbeddedAgentRun;
    abortDeps.resolveActiveEmbeddedRunIdentity =
      deps?.resolveActiveEmbeddedRunIdentity ?? defaultAbortDeps.resolveActiveEmbeddedRunIdentity;
    abortDeps.resolveActiveEmbeddedRunSessionId =
      deps?.resolveActiveEmbeddedRunSessionId ?? defaultAbortDeps.resolveActiveEmbeddedRunSessionId;
    abortDeps.markSessionAbortTarget =
      deps?.markSessionAbortTarget ?? defaultAbortDeps.markSessionAbortTarget;
    abortDeps.resolveSessionAbortTarget =
      deps?.resolveSessionAbortTarget ?? defaultAbortDeps.resolveSessionAbortTarget;
    abortDeps.getLatestSubagentRunByChildSessionKey =
      deps?.getLatestSubagentRunByChildSessionKey ??
      defaultAbortDeps.getLatestSubagentRunByChildSessionKey;
    abortDeps.listSubagentRunsForController =
      deps?.listSubagentRunsForController ?? defaultAbortDeps.listSubagentRunsForController;
    abortDeps.killControlledSubagentRun =
      deps?.killControlledSubagentRun ?? defaultAbortDeps.killControlledSubagentRun;
  },
  resetDepsForTests(): void {
    abortDeps.getAcpSessionManager = defaultAbortDeps.getAcpSessionManager;
    abortDeps.abortEmbeddedAgentRun = defaultAbortDeps.abortEmbeddedAgentRun;
    abortDeps.resolveActiveEmbeddedRunIdentity = defaultAbortDeps.resolveActiveEmbeddedRunIdentity;
    abortDeps.resolveActiveEmbeddedRunSessionId =
      defaultAbortDeps.resolveActiveEmbeddedRunSessionId;
    abortDeps.markSessionAbortTarget = defaultAbortDeps.markSessionAbortTarget;
    abortDeps.resolveSessionAbortTarget = defaultAbortDeps.resolveSessionAbortTarget;
    abortDeps.getLatestSubagentRunByChildSessionKey =
      defaultAbortDeps.getLatestSubagentRunByChildSessionKey;
    abortDeps.listSubagentRunsForController = defaultAbortDeps.listSubagentRunsForController;
    abortDeps.killControlledSubagentRun = defaultAbortDeps.killControlledSubagentRun;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.abortTestApi")] = abortTestApi;
}

function abortSessionRunTargetWithOutcome(params: {
  key?: string;
  sessionId?: string;
  recoveryRun?: MainSessionRecoveryRunIdentity;
  onRecoveryRunAborted?: () => void;
}): {
  active: boolean;
  aborted: boolean;
} {
  const sessionIds = new Set<string>();
  const key = normalizeOptionalString(params.key);
  let active = key ? replyRunRegistry.isActive(key) : false;
  if (key) {
    const activeSessionId = abortDeps.resolveActiveEmbeddedRunSessionId(key);
    if (activeSessionId) {
      active = true;
      sessionIds.add(activeSessionId);
    }
  }
  const explicitSessionId = normalizeOptionalString(params.sessionId);
  if (explicitSessionId) {
    sessionIds.add(explicitSessionId);
  }

  let aborted = false;
  let abortError: unknown;
  try {
    aborted = key ? replyRunRegistry.abort(key) : false;
  } catch (error) {
    abortError = error;
  }
  for (const sessionId of sessionIds) {
    try {
      const recoveryRun = params.recoveryRun;
      const activeRun = recoveryRun
        ? abortDeps.resolveActiveEmbeddedRunIdentity(sessionId)
        : undefined;
      const embeddedAborted = abortDeps.abortEmbeddedAgentRun(sessionId);
      if (
        embeddedAborted &&
        recoveryRun &&
        activeRun?.sessionId === recoveryRun.sessionId &&
        activeRun.runId === recoveryRun.runId &&
        activeRun.lifecycleGeneration === recoveryRun.lifecycleGeneration
      ) {
        params.onRecoveryRunAborted?.();
      }
      aborted = embeddedAborted || aborted;
    } catch (error) {
      abortError ??= error;
    }
  }
  if (abortError) {
    throw abortError instanceof Error ? abortError : new Error(formatErrorMessage(abortError));
  }
  return { active, aborted };
}

export async function abortSessionRunTarget(params: {
  key?: string;
  sessionId?: string;
  storePath?: string;
}) {
  const operation = params.key ? replyRunRegistry.get(params.key) : undefined;
  const runIdentity = params.sessionId
    ? abortDeps.resolveActiveEmbeddedRunIdentity(params.sessionId)
    : undefined;
  const recoveryRun =
    runIdentity && params.key && params.storePath
      ? {
          ...runIdentity,
          sessionKey: params.key,
          storePath: params.storePath,
        }
      : undefined;
  let recoveryRunAborted = false;
  return await runReplyRecoveryUserAbort({
    operation,
    recoveryRun,
    didAbortRecoveryRun: () => recoveryRunAborted,
    abort: () =>
      abortSessionRunTargetWithOutcome({
        ...params,
        recoveryRun,
        onRecoveryRunAborted: () => {
          recoveryRunAborted = true;
        },
      }),
    logLabel: params.key ?? "unknown session",
  });
}

export function formatAbortReplyText(
  stoppedSubagents?: number,
  rejectionReason?: "finalizing",
  failedSubagents?: number,
  recoveryPersistenceFailed?: boolean,
): string {
  const persistenceSuffix = recoveryPersistenceFailed
    ? " OpenClaw could not persist the cancellation. Retry /stop."
    : "";
  const failureSuffix =
    typeof failedSubagents === "number" && failedSubagents > 0
      ? ` ${failedSubagents === 1 ? "One sub-agent could not be stopped" : `${failedSubagents} sub-agents could not be stopped`}. Retry /stop.`
      : "";
  if (rejectionReason === "finalizing") {
    const base = "Agent reply is already finalizing and can no longer be aborted.";
    if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
      return `${base}${persistenceSuffix}${failureSuffix}`;
    }
    const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
    return `${base} Stopped ${stoppedSubagents} ${label}.${persistenceSuffix}${failureSuffix}`;
  }
  if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
    return `⚙️ Agent was aborted.${persistenceSuffix}${failureSuffix}`;
  }
  const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
  return `⚙️ Agent was aborted. Stopped ${stoppedSubagents} ${label}.${persistenceSuffix}${failureSuffix}`;
}

function resolveStoredSessionId(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): string | undefined {
  const agentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  try {
    return loadSessionEntry({
      agentId,
      clone: false,
      sessionKey: params.sessionKey,
      storePath,
    })?.sessionId;
  } catch {
    return undefined;
  }
}

function resolveBoundAcpAbortTargetSessionKey(params: {
  ctx: FinalizedRuntimeMsgContext;
  cfg: OpenClawConfig;
  activeSessionKey: string;
}): string | undefined {
  const bindingContext = resolveConversationBindingContextFromMessage({
    cfg: params.cfg,
    ctx: params.ctx,
  });
  if (!bindingContext) {
    return undefined;
  }
  return resolveEffectiveResetTargetSessionKey({
    cfg: params.cfg,
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    parentConversationId: bindingContext.parentConversationId,
    activeSessionKey: params.activeSessionKey,
    skipConfiguredFallbackWhenActiveSessionNonAcp: false,
    fallbackToActiveAcpWhenUnbound: false,
  });
}

function normalizeRequesterSessionKey(
  cfg: OpenClawConfig,
  key: string | undefined,
): string | undefined {
  const cleaned = normalizeOptionalString(key);
  if (!cleaned) {
    return undefined;
  }
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  return resolveInternalSessionKey({ key: cleaned, alias, mainKey });
}

export async function stopSubagentsForRequester(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
}): Promise<{ stopped: number; failed: number }> {
  const requesterKey = normalizeRequesterSessionKey(params.cfg, params.requesterSessionKey);
  if (!requesterKey) {
    return { stopped: 0, failed: 0 };
  }
  const dedupedRunsByChildKey = new Map<string, SubagentRunRecord>();
  for (const run of abortDeps.listSubagentRunsForController(requesterKey)) {
    const childKey = normalizeOptionalString(run.childSessionKey);
    if (!childKey) {
      continue;
    }
    const latest = abortDeps.getLatestSubagentRunByChildSessionKey(childKey);
    if (!latest) {
      const existing = dedupedRunsByChildKey.get(childKey);
      if (!existing || run.createdAt >= existing.createdAt) {
        dedupedRunsByChildKey.set(childKey, run);
      }
      continue;
    }
    const latestControllerSessionKey =
      normalizeOptionalString(latest?.controllerSessionKey) ??
      normalizeOptionalString(latest?.requesterSessionKey);
    if (
      latest.runId !== run.runId ||
      latest.generation !== run.generation ||
      latest.createdAt !== run.createdAt ||
      latestControllerSessionKey !== requesterKey
    ) {
      continue;
    }
    const existing = dedupedRunsByChildKey.get(childKey);
    if (!existing || run.createdAt >= existing.createdAt) {
      dedupedRunsByChildKey.set(childKey, latest);
    }
  }
  const runs = Array.from(dedupedRunsByChildKey.values());
  if (runs.length === 0) {
    return { stopped: 0, failed: 0 };
  }

  let stopped = 0;
  let failed = 0;

  for (const run of runs) {
    const childKey = normalizeOptionalString(run.childSessionKey);
    if (!childKey) {
      continue;
    }
    const result = await abortDeps.killControlledSubagentRun({
      cfg: params.cfg,
      controller: {
        controllerSessionKey: requesterKey,
        callerSessionKey: requesterKey,
        callerIsSubagent: isSubagentSessionKey(requesterKey),
        controlScope: "children",
      },
      entry: run,
      suppressTaskDelivery: true,
    });
    if (result.status === "ok" || result.status === "error") {
      const killed = "killed" in result && result.killed ? 1 : 0;
      const cascadeKilled = "cascadeKilled" in result ? result.cascadeKilled : 0;
      stopped += killed + cascadeKilled;
      if (result.status === "error") {
        failed += 1;
        logVerbose(`abort: failed to kill subagent ${run.runId}: ${result.error}`);
      }
    }
  }

  if (stopped > 0) {
    logVerbose(`abort: stopped ${stopped} subagent run(s) for ${requesterKey}`);
  }
  return { stopped, failed };
}

export async function tryFastAbortFromMessage(params: {
  ctx: FinalizedRuntimeMsgContext;
  cfg: OpenClawConfig;
}): Promise<{
  handled: boolean;
  aborted: boolean;
  rejectionReason?: "finalizing";
  stoppedSubagents?: number;
  failedSubagents?: number;
  recoveryPersistenceFailed?: boolean;
}> {
  const { ctx, cfg } = params;
  const commandSessionKey =
    normalizeOptionalString(ctx.SessionKey) ?? normalizeOptionalString(ctx.ParentSessionKey);
  const targetKey = normalizeOptionalString(ctx.CommandTargetSessionKey) ?? commandSessionKey;
  const raw = stripStructuralPrefixes(ctx.commandText);
  const isGroup = normalizeOptionalLowercaseString(ctx.ChatType) === "group";
  const stripped = isGroup
    ? stripMentions(
        raw,
        ctx,
        cfg,
        resolveSessionAgentId({
          sessionKey: targetKey ?? ctx.SessionKey ?? "",
          config: cfg,
        }),
      )
    : raw;
  const abortRequested = isAbortRequestText(stripped);
  if (!abortRequested) {
    return { handled: false, aborted: false };
  }

  const commandAuthorized = ctx.CommandAuthorized;
  const auth = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized,
  });
  if (!auth.isAuthorizedSender) {
    return { handled: false, aborted: false };
  }

  const agentId = resolveSessionAgentId({
    sessionKey: targetKey ?? ctx.SessionKey ?? "",
    config: cfg,
  });
  const abortKey = targetKey ?? auth.from ?? auth.to;
  const requesterSessionKey = targetKey ?? ctx.SessionKey ?? abortKey;

  if (targetKey) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const abortCutoffForTarget = (target: SessionAbortTargetContext): AbortCutoff | undefined =>
      shouldPersistAbortCutoff({
        commandSessionKey,
        targetSessionKey: target.sessionKey,
      })
        ? resolveAbortCutoffFromContext(ctx)
        : undefined;
    let resolvedAbortTarget: SessionAbortTargetIdentity | null = null;
    try {
      resolvedAbortTarget = abortDeps.resolveSessionAbortTarget({
        agentId,
        sessionKey: targetKey,
        storePath,
      });
    } catch (error) {
      logVerbose(
        `abort: failed to resolve abort metadata for ${targetKey}: ${formatErrorMessage(error)}`,
      );
    }
    const resolvedTargetKey = resolvedAbortTarget?.sessionKey ?? targetKey;
    const conversationBoundAcpTargetKey = commandSessionKey
      ? resolveBoundAcpAbortTargetSessionKey({
          ctx,
          cfg,
          activeSessionKey: commandSessionKey,
        })
      : undefined;
    const boundAcpTargetKey = !isAcpSessionKey(resolvedTargetKey)
      ? conversationBoundAcpTargetKey
      : undefined;
    const abortTargetKeys = [resolvedTargetKey];
    if (boundAcpTargetKey && boundAcpTargetKey !== resolvedTargetKey) {
      abortTargetKeys.push(boundAcpTargetKey);
    }
    const acpManager = abortDeps.getAcpSessionManager();
    for (const acpTargetKey of abortTargetKeys.filter(isAcpSessionKey)) {
      const acpResolution = acpManager.resolveSession({
        cfg,
        sessionKey: acpTargetKey,
      });
      if (acpResolution.kind === "none") {
        continue;
      }
      try {
        await acpManager.cancelSession({
          cfg,
          sessionKey: acpTargetKey,
          reason: "fast-abort",
        });
      } catch (error) {
        logVerbose(`abort: ACP cancel failed for ${acpTargetKey}: ${formatErrorMessage(error)}`);
      }
    }
    const sourceAbortKey =
      commandSessionKey &&
      !abortTargetKeys.includes(commandSessionKey) &&
      conversationBoundAcpTargetKey &&
      abortTargetKeys.includes(conversationBoundAcpTargetKey)
        ? commandSessionKey
        : undefined;
    const sessionIdsByKey = new Map<string, string | undefined>(
      abortTargetKeys.map((abortTargetKey) => [
        abortTargetKey,
        replyRunRegistry.resolveSessionId(abortTargetKey) ??
          (abortTargetKey === resolvedTargetKey
            ? resolvedAbortTarget?.sessionId
            : resolveStoredSessionId({ cfg, sessionKey: abortTargetKey })),
      ]),
    );
    let aborted = false;
    let activeAbortRejected = false;
    let recoveryPersistenceFailed = false;
    const recoveryAbortTargetKeys = new Set<string>();
    for (const abortTargetKey of abortTargetKeys) {
      const outcome = await abortSessionRunTarget({
        key: abortTargetKey,
        sessionId: sessionIdsByKey.get(abortTargetKey),
        storePath,
      });
      activeAbortRejected ||= outcome.active && !outcome.aborted;
      recoveryPersistenceFailed ||= Boolean(outcome.recoveryPersistenceErrors?.length);
      for (const recovery of outcome.recoveries ?? []) {
        recoveryAbortTargetKeys.add(recovery.sessionKey);
      }
      aborted = outcome.aborted || aborted;
    }
    const sourceSessionId = sourceAbortKey
      ? (replyRunRegistry.resolveSessionId(sourceAbortKey) ??
        resolveStoredSessionId({ cfg, sessionKey: sourceAbortKey }))
      : undefined;
    if (sourceAbortKey) {
      const outcome = await abortSessionRunTarget({
        key: sourceAbortKey,
        sessionId: sourceSessionId,
        storePath,
      });
      activeAbortRejected ||= outcome.active && !outcome.aborted;
      recoveryPersistenceFailed ||= Boolean(outcome.recoveryPersistenceErrors?.length);
      for (const recovery of outcome.recoveries ?? []) {
        recoveryAbortTargetKeys.add(recovery.sessionKey);
      }
      aborted = outcome.aborted || aborted;
    }
    const cleared = clearSessionQueues(
      abortTargetKeys
        .flatMap((abortTargetKey) => [abortTargetKey, sessionIdsByKey.get(abortTargetKey)])
        .concat(sourceAbortKey, sourceSessionId),
    );
    if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
      logVerbose(
        `abort: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
      );
    }
    const { stopped, failed } = await stopSubagentsForRequester({ cfg, requesterSessionKey });
    if (activeAbortRejected && !aborted) {
      return {
        handled: true,
        aborted: false,
        rejectionReason: "finalizing",
        stoppedSubagents: stopped,
        failedSubagents: failed,
        ...(recoveryPersistenceFailed ? { recoveryPersistenceFailed: true } : {}),
      };
    }
    let persistedAbortTarget: SessionAbortTargetResult | null = null;
    const abortMetadataKeys =
      recoveryAbortTargetKeys.size > 0
        ? [...recoveryAbortTargetKeys]
        : recoveryPersistenceFailed
          ? []
          : [targetKey];
    for (const sessionKey of abortMetadataKeys) {
      try {
        const result = await abortDeps.markSessionAbortTarget({
          scope: {
            agentId,
            sessionKey,
            storePath,
          },
          resolveAbortCutoff: abortCutoffForTarget,
        });
        if (result?.persisted === true || !persistedAbortTarget) {
          persistedAbortTarget = result;
        }
      } catch (error) {
        logVerbose(
          `abort: failed to persist abort metadata for ${sessionKey}: ${formatErrorMessage(error)}`,
        );
      }
    }
    if (persistedAbortTarget?.persisted === false) {
      logVerbose(
        `abort: failed to persist abort metadata for ${targetKey}: ${persistedAbortTarget.persistenceError ?? "unknown error"}`,
      );
    }
    const abortMemoryKey =
      persistedAbortTarget?.sessionKey ?? resolvedAbortTarget?.sessionKey ?? abortKey;
    const hasAbortTargetEntry = Boolean(persistedAbortTarget?.entry ?? resolvedAbortTarget?.entry);
    if (
      !recoveryPersistenceFailed &&
      persistedAbortTarget?.persisted !== true &&
      abortMemoryKey &&
      !hasAbortTargetEntry
    ) {
      setAbortMemory(abortMemoryKey, true);
    }
    return {
      handled: true,
      aborted,
      stoppedSubagents: stopped,
      failedSubagents: failed,
      ...(recoveryPersistenceFailed ? { recoveryPersistenceFailed: true } : {}),
    };
  }

  if (abortKey) {
    setAbortMemory(abortKey, true);
  }
  const { stopped, failed } = await stopSubagentsForRequester({ cfg, requesterSessionKey });
  return {
    handled: true,
    aborted: false,
    stoppedSubagents: stopped,
    failedSubagents: failed,
  };
}
