import { t } from "../i18n/index.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { moveSessionSection, normalizeSessionSectionOrder } from "../lib/sessions/grouping.ts";
import { readSessionChangedTarget } from "../lib/sessions/patch.ts";
import {
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { showToast } from "../lib/toast.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
  SidebarSessionPatch,
} from "./app-sidebar-session-types.ts";
import { requestCloudWorkerStop } from "./cloud-worker-stop.ts";
import type { SessionMenuAction } from "./session-menu.ts";
import {
  patchSessionRows,
  refreshSessionsAfterBatch,
  sessionRowAgentId,
} from "./session-organizer-batch-mutations.ts";
import type {
  SessionActionHost,
  SessionActionRow,
  SessionRowsPatchResult,
} from "./session-organizer-batch-mutations.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller.ts";

export type { SessionActionHost, SessionActionRow } from "./session-organizer-batch-mutations.ts";

function requireSessionMutationAccess(
  host: SessionActionHost,
  scope: SidebarSessionMutationScope,
  request: {
    method: string;
    params?: unknown;
    requiredScope?: "operator.write" | "operator.admin";
  },
): boolean {
  const access = readSessionMethodAccess(scope.gateway.snapshot, request);
  if (access.allowed) {
    return true;
  }
  host.sessionData.publishSessionMutationError(scope, access.reason);
  return false;
}

export async function patchSession(
  host: SessionActionHost,
  session: SessionActionRow,
  patch: SidebarSessionPatch,
  scope: SidebarSessionMutationScope,
  refresh: { deferListRefresh?: boolean } = {},
): Promise<SidebarSessionMutationResult> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return "stale";
  }
  const agentId = sessionRowAgentId(session, scope);
  // Identity travels with the patch so the Gateway, which owns the store, drops a
  // target whose session was replaced instead of applying this to its successor.
  const identifiedPatch = session.sessionId
    ? { ...patch, expectedSessionId: session.sessionId }
    : patch;
  const requestParams = {
    key: session.key,
    ...identifiedPatch,
    agentId,
  };
  if (
    !requireSessionMutationAccess(host, scope, { method: "sessions.patch", params: requestParams })
  ) {
    return "failed";
  }
  try {
    const patched = await scope.sessions.patch(session.key, identifiedPatch, {
      agentId,
      ...(refresh.deferListRefresh ? { deferListRefresh: true } : {}),
    });
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return "stale";
    }
    if (!patched) {
      if (scope.sessions.state.error) {
        host.sessionData.publishSessionMutationError(scope, scope.sessions.state.error);
      }
      return "failed";
    }
    // Unpin from any surface (menu, pin button, drag) retires the session's
    // persisted zone slot; leaving it would resurrect stale synced entries.
    // Archiving implicitly unpins server-side (sessions-patch clears
    // pinnedAt), so it retires the slot too.
    if (patch.pinned === false || (patch.archived === true && session.pinned)) {
      host.pruneSidebarSessionEntry(session.key);
    }
    if (!refresh.deferListRefresh && host.sidebarSessionStatusFilter() !== "active") {
      await host.sessionData.refreshSidebarSessions(agentId);
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
    }
    return "completed";
  } catch (error) {
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return "stale";
    }
    // A rotation was already re-aimed at the surviving session one layer down, so
    // reaching here with this shape means the row itself is gone. Patching the key
    // would create a new session, so the caller accounts for it instead.
    if (readSessionChangedTarget(error)) {
      return "session-gone";
    }
    host.sessionData.publishSessionMutationError(scope, error);
    return "failed";
  }
}

export async function patchSessions(
  host: SessionOrganizerControllerHost,
  rows: readonly SidebarRecentSession[],
  patch: SidebarSessionPatch,
  scope: SidebarSessionMutationScope,
): Promise<SidebarSessionMutationResult> {
  if (!scope) {
    return "stale";
  }
  if (rows.length === 0) {
    return "completed";
  }
  const patched = await patchSessionRows(host, rows, patch, scope, {
    fallback: () => patchSessionRowsSerial(host, rows, patch, scope),
  });
  if (!patched) {
    return host.sessionData.isSessionMutationScopeCurrent(scope) ? "failed" : "stale";
  }
  if (patched.rows.length === rows.length) {
    return "completed";
  }
  // `session-gone` only when vanished rows account for everything that did not
  // land; a mixed batch stays `failed` so the caller still offers the retry the
  // other failures deserve.
  return patched.rows.length + patched.gone.length === rows.length ? "session-gone" : "failed";
}

async function patchSessionRowsSerial(
  host: SessionActionHost,
  rows: readonly SessionActionRow[],
  patch: SidebarSessionPatch,
  scope: SidebarSessionMutationScope,
  options: { deferListRefresh?: boolean } = {},
): Promise<SessionRowsPatchResult | null> {
  const completed: SessionActionRow[] = [];
  const gone: SessionActionRow[] = [];
  for (const row of rows) {
    const result = await patchSession(host, row, patch, scope, { deferListRefresh: true });
    if (result === "stale") {
      return null;
    }
    if (result === "completed") {
      completed.push(row);
    } else if (result === "session-gone") {
      gone.push(row);
    }
  }
  if (!options.deferListRefresh) {
    const refreshed = await refreshSessionsAfterBatch(host, scope, rows);
    if (refreshed === "stale") {
      return null;
    }
  }
  return { rows: completed, gone };
}

export async function archiveSessionWithUndo(
  host: SessionActionHost,
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
) {
  const result = await patchSession(host, session, { archived: true }, scope);
  if (result !== "completed" || !host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  showToast({
    message: t("sessionsView.sessionArchived"),
    actionLabel: t("common.undo"),
    onAction: () =>
      void restoreArchivedSessions(host, [{ session, pinned: session.pinned }], scope),
  });
}

async function archiveSessionsWithUndo(
  host: SessionOrganizerControllerHost,
  rows: readonly SidebarRecentSession[],
  scope: SidebarSessionMutationScope,
) {
  if (rows.length === 0) {
    return;
  }
  const archivedRows = await patchSessionRows(host, rows, { archived: true }, scope, {
    fallback: () => patchSessionRowsSerial(host, rows, { archived: true }, scope),
  });
  if (!archivedRows || archivedRows.rows.length === 0) {
    return;
  }
  const archived = archivedRows.rows.map((session) => ({ session, pinned: session.pinned }));
  showToast({
    message:
      archived.length === 1
        ? t("sessionsView.sessionArchived")
        : t("sessionsView.sessionsArchived", { count: String(archived.length) }),
    actionLabel: t("common.undo"),
    onAction: () => void restoreArchivedSessions(host, archived, scope),
  });
}

async function restoreArchivedSessions(
  host: SessionActionHost,
  archived: readonly { session: SessionActionRow; pinned: boolean }[],
  scope: SidebarSessionMutationScope,
) {
  const rows = archived.map((entry) => entry.session);
  const singleRowUndo = rows.length === 1;
  const restored = singleRowUndo
    ? await patchSessionRowsSerial(host, rows, { archived: false }, scope, {
        deferListRefresh: true,
      })
    : await patchSessionRows(host, rows, { archived: false }, scope, {
        deferListRefresh: true,
        fallback: () =>
          patchSessionRowsSerial(host, rows, { archived: false }, scope, {
            deferListRefresh: true,
          }),
      });
  if (!restored) {
    return;
  }
  const repinRows = archived.flatMap(({ session, pinned }) =>
    pinned && restored.rows.includes(session) ? [session] : [],
  );
  if (repinRows.length > 0) {
    const repinned = singleRowUndo
      ? await patchSessionRowsSerial(host, repinRows, { pinned: true }, scope, {
          deferListRefresh: true,
        })
      : await patchSessionRows(host, repinRows, { pinned: true }, scope, {
          deferListRefresh: true,
          fallback: () =>
            patchSessionRowsSerial(host, repinRows, { pinned: true }, scope, {
              deferListRefresh: true,
            }),
        });
    if (!repinned && !host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  await refreshSessionsAfterBatch(host, scope, rows);
}

/** One confirm and one preserved-worktrees alert for the whole selection. */
export async function deleteSessionsBatch(
  host: SessionOrganizerControllerHost,
  rows: readonly SidebarRecentSession[],
  scope: SidebarSessionMutationScope,
) {
  if (rows.length === 0) {
    return;
  }
  if (!window.confirm(t("sessionsView.deleteSessionsConfirm", { count: String(rows.length) }))) {
    return;
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  const requests = rows.map((row) => ({
    key: row.key,
    agentId: parseAgentSessionKey(row.key)?.agentId ?? scope.selectedAgentId,
    deleteTranscript: true,
    ...(row.archived === true ? { archivedOnly: true } : {}),
  }));
  for (const params of requests) {
    if (!requireSessionMutationAccess(host, scope, { method: "sessions.delete", params })) {
      return;
    }
  }
  try {
    const result = await scope.sessions.deleteMany(requests);
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    if (host.sidebarSessionStatusFilter() !== "active") {
      await host.sessionData.refreshSidebarSessions(scope.selectedAgentId);
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return;
      }
    }
    if (result.preservedWorktrees.length > 0) {
      window.alert(
        t("sessionsView.deletePreservedWorktrees", {
          count: String(result.preservedWorktrees.length),
          branches: result.preservedWorktrees.map((worktree) => worktree.branch).join(", "),
        }),
      );
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return;
      }
    }
    const deletedActive = rows.find((row) => row.active && result.deleted.includes(row.key));
    if (deletedActive) {
      host.replaceCurrentSession(
        buildAgentMainSessionKey({
          agentId: parseAgentSessionKey(deletedActive.key)?.agentId ?? scope.selectedAgentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: scope.context.agents.state.agentsList,
            hello: scope.gateway.snapshot.hello,
          }),
        }),
      );
    }
    if (result.errors.length > 0) {
      host.sessionData.publishSessionMutationError(scope, result.errors.join("; "));
    }
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}

export async function runBatchSessionAction(
  host: SessionOrganizerControllerHost,
  action: SessionMenuAction,
  rows: SidebarRecentSession[],
  allUnread: boolean,
  scope: SidebarSessionMutationScope,
): Promise<void> {
  switch (action.kind) {
    case "toggle-unread":
      await patchSessions(host, rows, { unread: !allUnread }, scope);
      break;
    case "move-to-group":
      await patchSessions(
        host,
        rows.filter((row) => (row.category ?? null) !== action.category),
        { category: action.category },
        scope,
      );
      break;
    case "toggle-archived":
      if (rows.every((row) => row.archived === true)) {
        await patchSessionRows(host, rows, { archived: false }, scope, {
          fallback: () => patchSessionRowsSerial(host, rows, { archived: false }, scope),
        });
      } else {
        await archiveSessionsWithUndo(
          host,
          rows.filter((row) => row.archived !== true),
          scope,
        );
      }
      break;
    case "delete":
      await deleteSessionsBatch(host, rows, scope);
      break;
    default:
      break;
  }
}

async function rememberSessionGroup(
  host: SessionOrganizerControllerHost,
  name: string,
  scope: SidebarSessionMutationScope,
): Promise<SidebarSessionMutationResult> {
  const groups = host.knownSessionGroups();
  if (groups.includes(name)) {
    return "completed";
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return "stale";
  }
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.groups.put",
      requiredScope: "operator.write",
    })
  ) {
    return "failed";
  }
  try {
    const written = await scope.sessions.groupsPut([...groups, name]);
    // The catalog owns the authoritative stale signal; the mutation scope adds
    // its own. Either one retiring means no confirmed entry to assign against.
    return written === "completed" && host.sessionData.isSessionMutationScopeCurrent(scope)
      ? "completed"
      : "stale";
  } catch (error) {
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return "stale";
    }
    host.sessionData.publishSessionMutationError(scope, error);
    return "failed";
  }
}

export async function renameSession(
  host: SessionOrganizerControllerHost,
  session: SidebarRecentSession,
  label: string,
  scope: SidebarSessionMutationScope,
): Promise<void> {
  await patchSession(host, session, { label: normalizeOptionalString(label) ?? null }, scope);
}

export async function createSessionGroup(
  host: SessionOrganizerControllerHost,
  name: string,
  sessions: readonly SidebarRecentSession[],
  scope: SidebarSessionMutationScope,
): Promise<SidebarSessionMutationResult> {
  const remembered = await rememberSessionGroup(host, name, scope);
  if (remembered !== "completed") {
    return remembered;
  }
  // The rows carry the identity captured when the operator picked them, so a
  // rotated session is re-aimed silently and a gone one is refused rather than
  // recreated. Nothing is re-resolved against the sidebar list: it is a bounded,
  // filtered projection, and a row leaving it is no evidence the session is gone.
  if (sessions.length > 0) {
    const moved =
      sessions.length === 1
        ? await patchSession(host, sessions[0]!, { category: name }, scope)
        : await patchSessions(host, sessions, { category: name }, scope);
    // The group itself landed and is on screen; only a member could not join it.
    // One quiet line naming both, then nothing further to do.
    if (moved === "session-gone" && host.sessionData.isSessionMutationScopeCurrent(scope)) {
      showToast({
        message:
          sessions.length === 1
            ? t("sessionsView.newGroupSessionGone", {
                group: name,
                session: sessions[0]!.label,
              })
            : t("sessionsView.newGroupSessionsGone", { group: name }),
        durationMs: 12_000,
      });
      return "completed";
    }
    return moved;
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return "stale";
  }
  // Header-created groups start empty; re-render so the new section shows up.
  host.requestUpdate();
  return "completed";
}

export async function renameSessionGroup(
  host: SessionOrganizerControllerHost,
  group: string,
  next: string,
  scope: SidebarSessionMutationScope,
): Promise<boolean> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return false;
  }
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.groups.rename",
      requiredScope: "operator.write",
    })
  ) {
    return false;
  }
  try {
    const outcome = await scope.sessions.groupsRename(group, next);
    return outcome === "completed" && host.sessionData.isSessionMutationScopeCurrent(scope);
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
    return false;
  }
}

export async function deleteSessionGroup(
  host: SessionOrganizerControllerHost,
  group: string,
  scope: SidebarSessionMutationScope,
): Promise<boolean> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return false;
  }
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.groups.delete",
      requiredScope: "operator.write",
    })
  ) {
    return false;
  }
  try {
    const outcome = await scope.sessions.groupsDelete(group);
    return outcome === "completed" && host.sessionData.isSessionMutationScopeCurrent(scope);
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
    return false;
  }
}

export async function reorderSidebarSection(
  host: SessionOrganizerControllerHost,
  sourceSectionId: string,
  targetSectionId: string,
  position: "before" | "after",
  scope: SidebarSessionMutationScope,
): Promise<void> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.groups.put",
      requiredScope: "operator.write",
    })
  ) {
    return;
  }
  try {
    // knownSessionGroups() is the full discovered set (gateway catalog plus
    // row-discovered categories), so normalize only prunes deleted groups.
    const knownGroups = host.knownSessionGroups();
    const knownCatalogIds = host.knownSessionCatalogIds();
    const next = moveSessionSection(
      normalizeSessionSectionOrder(host.knownSectionOrder(), knownGroups, knownCatalogIds),
      sourceSectionId,
      targetSectionId,
      position,
    );
    const nextGroups = next.flatMap((token) =>
      token.startsWith("category:") ? [token.slice("category:".length)] : [],
    );
    // No capability gate: the gateway serves this UI from its own dist, so a
    // newer UI never talks to an older gateway's closed put schema outside dev.
    await scope.sessions.groupsPut(nextGroups, next);
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    host.requestUpdate();
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}

export async function assignSessionCategory(
  host: SessionOrganizerControllerHost,
  session: SidebarRecentSession,
  category: string | null,
  scope: SidebarSessionMutationScope,
  patch: { pinned?: boolean } = {},
): Promise<void> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  if (category && (await rememberSessionGroup(host, category, scope)) !== "completed") {
    return;
  }
  await patchSession(host, session, { category, ...patch }, scope);
}

export async function forkSession(
  host: SessionActionHost,
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
) {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
  const createParams = {
    parentSessionKey: session.key,
    fork: true,
    agentId,
  };
  if (
    !requireSessionMutationAccess(host, scope, { method: "sessions.create", params: createParams })
  ) {
    return;
  }
  try {
    const key = await scope.sessions.create(createParams);
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    if (key) {
      host.selectSession(key);
    } else {
      host.sessionData.publishSessionMutationError(
        scope,
        scope.sessions.state.error ?? t("newSession.createFailed"),
      );
    }
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}

export async function stopCloudWorker(
  host: SessionOrganizerControllerHost,
  session: SidebarRecentSession,
  scope: SidebarSessionMutationScope,
) {
  const stopAction = session.cloudWorkerStopAction;
  if (
    !stopAction ||
    (stopAction.method === "sessions.reclaim" && session.hasActiveRun) ||
    !window.confirm(t("sessionsView.stopCloudWorkerConfirm", { session: session.label }))
  ) {
    return;
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  if (!requireSessionMutationAccess(host, scope, stopAction)) {
    return;
  }
  try {
    const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
    const result = await requestCloudWorkerStop(scope.client, stopAction, {
      key: session.key,
      agentId,
    });
    if (result && host.sessionData.isSessionMutationScopeCurrent(scope)) {
      showToast({
        message: t("sessionsView.cloudWorkerStopResult", {
          session: session.label,
          state: result.worker?.state ?? result.status,
        }),
      });
    }
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    await scope.sessions.refreshReplacement(agentId);
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}

export async function deleteSession(
  host: SessionActionHost,
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
) {
  if (!window.confirm(t("sessionsView.deleteSessionConfirm", { session: session.label }))) {
    return;
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
  const deleteParams = {
    agentId,
    deleteTranscript: true,
    ...(session.archived === true ? { archivedOnly: true } : {}),
  };
  if (
    !requireSessionMutationAccess(host, scope, {
      method: "sessions.delete",
      params: { key: session.key, ...deleteParams },
    })
  ) {
    return;
  }
  try {
    const outcome = await scope.sessions.delete(session.key, deleteParams);
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return;
    }
    if (host.sidebarSessionStatusFilter() !== "active") {
      await host.sessionData.refreshSidebarSessions(agentId);
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return;
      }
    }
    // Dirty/unpushed checkouts survive deletion; offer explicit removal.
    if (outcome.worktreePreserved) {
      const preserved = outcome.worktreePreserved;
      const removeAccess = readSessionMethodAccess(scope.gateway.snapshot, {
        method: "worktrees.remove",
        requiredScope: "operator.admin",
      });
      if (!removeAccess.allowed) {
        window.alert(
          t("sessionsView.deletePreservedWorktrees", {
            count: "1",
            branches: preserved.branch,
          }),
        );
        if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
          return;
        }
      } else if (
        window.confirm(
          t("sessionsView.deletePreservedWorktreeConfirm", { branch: preserved.branch }),
        )
      ) {
        if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
          return;
        }
        try {
          await scope.client.request("worktrees.remove", {
            id: preserved.id,
            force: true,
          });
        } catch (error) {
          host.sessionData.publishSessionMutationError(scope, error);
        }
        if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
          return;
        }
      }
    }
    if (!outcome.deleted || !session.active) {
      return;
    }
    host.replaceCurrentSession(
      buildAgentMainSessionKey({
        agentId,
        mainKey: resolveUiConfiguredMainKey({
          agentsList: scope.context.agents.state.agentsList,
          hello: scope.gateway.snapshot.hello,
        }),
      }),
    );
  } catch (error) {
    host.sessionData.publishSessionMutationError(scope, error);
  }
}
