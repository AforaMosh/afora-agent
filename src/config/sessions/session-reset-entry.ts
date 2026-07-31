import { isSubagentSessionKey } from "../../routing/session-key.js";
import { rebindCliSessionReseedReceiptsForReset } from "./cli-session-binding.js";
import { resolveResetPreservedSelection } from "./reset-preserved-selection.js";
import { sessionEntryForkedFromParent } from "./session-entry-lineage.js";
import {
  buildSessionCreationStamp,
  type SessionCreatedActor,
  type SessionCreatedVia,
} from "./session-entry-provenance.js";
import type { SessionEntry } from "./types.js";

type BuildSessionResetEntryParams = {
  currentEntry?: SessionEntry;
  primaryKey: string;
  resetBoundaryAppended: boolean;
  now: number;
  createId: () => string;
  creation?: { via: SessionCreatedVia; actor?: SessionCreatedActor };
  authorizedPluginId?: string;
  execNode?: string;
  execCwd?: string;
  clearExecBinding?: boolean;
  spawnedCwd?: string;
  worktree?: SessionEntry["worktree"];
  clearSpawnedCwd?: boolean;
};

/** Builds the canonical persisted row for a session reset or first materialization. */
export function buildSessionResetEntry(params: BuildSessionResetEntryParams): SessionEntry {
  const current = params.currentEntry;
  const nextSessionId = current?.sessionId ?? params.createId();
  const creationStamp = current
    ? {
        createdVia: current.createdVia,
        createdActor: current.createdActor,
        createdAt: current.createdAt,
      }
    : params.creation
      ? buildSessionCreationStamp({ ...params.creation, now: params.now })
      : {};
  const nextEntry: SessionEntry = {
    sessionId: nextSessionId,
    lifecycleRevision: params.createId(),
    updatedAt: params.now,
    sessionStartedAt: params.now,
    systemSent: false,
    abortedLastRun: false,
    thinkingLevel: current?.thinkingLevel,
    fastMode: current?.fastMode,
    toolOverrides: current?.toolOverrides,
    verboseLevel: current?.verboseLevel,
    traceLevel: current?.traceLevel,
    reasoningLevel: current?.reasoningLevel,
    elevatedLevel: current?.elevatedLevel,
    ttsAuto: current?.ttsAuto,
    execHost: params.execNode ? "node" : params.clearExecBinding ? undefined : current?.execHost,
    execSecurity: current?.execSecurity,
    execAsk: current?.execAsk,
    execNode: params.execNode
      ? params.execNode
      : params.clearExecBinding
        ? undefined
        : current?.execNode,
    execCwd: params.execNode
      ? params.execCwd
      : params.clearExecBinding
        ? undefined
        : current?.execCwd,
    responseUsage: current?.responseUsage,
    pinnedAt: current?.pinnedAt,
    icon: current?.icon,
    // Keep explicit user selection, but drop runtime fallback state from the old turn.
    ...resolveResetPreservedSelection({ entry: current }),
    groupActivation: current?.groupActivation,
    groupActivationNeedsSystemIntro: current?.groupActivationNeedsSystemIntro,
    chatType: current?.chatType,
    compactionCount: 0,
    sendPolicy: current?.sendPolicy,
    queueMode: current?.queueMode,
    queueDebounceMs: current?.queueDebounceMs,
    queueCap: current?.queueCap,
    queueDrop: current?.queueDrop,
    spawnedBy: current?.spawnedBy,
    spawnedWorkspaceDir: current?.spawnedWorkspaceDir,
    spawnedCwd: params.clearSpawnedCwd ? undefined : (params.spawnedCwd ?? current?.spawnedCwd),
    worktree: params.clearSpawnedCwd ? undefined : (params.worktree ?? current?.worktree),
    parentSessionKey: current?.parentSessionKey,
    ...creationStamp,
    forkSource: current?.forkSource,
    forkedFromParent: sessionEntryForkedFromParent(current) ? true : undefined,
    spawnDepth: current?.spawnDepth,
    subagentRole: current?.subagentRole,
    subagentControlScope: current?.subagentControlScope,
    label: current?.label,
    displayName: current?.displayName,
    delivery: current?.delivery,
    groupId: current?.groupId,
    subject: current?.subject,
    groupChannel: current?.groupChannel,
    space: current?.space,
    pluginOwnerId: current?.pluginOwnerId ?? params.authorizedPluginId,
    cliSessionBindings: current?.cliSessionBindings,
    cliSessionIds: current?.cliSessionIds,
    claudeCliSessionId: current?.claudeCliSessionId,
    usageFamilyKey: current?.usageFamilyKey,
    usageFamilySessionIds: current?.usageFamilySessionIds,
    // Skills snapshots and transient run fields are intentionally omitted so
    // the next turn rebuilds them against the current runtime.
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalTokensFresh: true,
  };

  // Normal resets start a fresh provider-side CLI conversation. Spawned
  // subagents retain their provider binding because orchestration owns it.
  if (params.resetBoundaryAppended && !isSubagentSessionKey(params.primaryKey)) {
    nextEntry.cliSessionBindings = undefined;
    nextEntry.cliSessionIds = undefined;
    nextEntry.claudeCliSessionId = undefined;
  } else {
    nextEntry.cliSessionBindings = rebindCliSessionReseedReceiptsForReset(
      nextEntry.cliSessionBindings,
      nextSessionId,
    );
  }
  return nextEntry;
}
