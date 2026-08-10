import {
  SESSIONS_PATCH_MANY_MAX_TARGETS,
  type SessionsPatchManyParams,
  type SessionsPatchManyResult,
  type SessionsPatchMutation,
} from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { SESSION_ARCHIVE_REQUEST_OPTIONS } from "../../../src/shared/session-archive-timeout.ts";
import { GatewayRequestError } from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { isSessionPresentationPatch, readSessionChangedTarget } from "../lib/sessions/patch.ts";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller.ts";

export type SessionActionRow = Pick<
  SidebarRecentSession,
  "key" | "sessionId" | "label" | "pinned" | "archived" | "active"
>;

export type SessionRowsPatchResult = {
  rows: SessionActionRow[];
  /** Rows the Gateway reports as gone; patching their keys again would create new sessions. */
  gone: SessionActionRow[];
};

export type SessionActionHost = Pick<
  SessionOrganizerControllerHost,
  | "pruneSidebarSessionEntry"
  | "replaceCurrentSession"
  | "selectSession"
  | "sidebarSessionStatusFilter"
> & {
  readonly sessionData: Pick<
    SessionOrganizerControllerHost["sessionData"],
    "isSessionMutationScopeCurrent" | "publishSessionMutationError" | "refreshSidebarSessions"
  >;
};

function isLegacyPatchManyMethodRejection(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("unknown method: sessions.patchMany")
  );
}

export function sessionRowAgentId(
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
): string {
  return parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
}

/**
 * One list refresh per owning agent, replacing the per-row refreshes a batch
 * defers; each deferred row skipped a full `sessions.list` round trip and rode
 * pushed `sessions.changed` events instead. Agents come from the rows, not the
 * scope, because `patchSession` routes every mutation by its own key. The
 * result carries the stale/failed reporting the per-row refresh owed its caller.
 */
export async function refreshSessionsAfterBatch(
  host: SessionActionHost,
  scope: SidebarSessionMutationScope,
  rows: readonly SessionActionRow[],
): Promise<SidebarSessionMutationResult> {
  const agentIds = [...new Set(rows.map((row) => sessionRowAgentId(row, scope)))];
  const refreshSidebar = host.sidebarSessionStatusFilter() !== "active";
  for (const agentId of agentIds) {
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return "stale";
    }
    try {
      await scope.sessions.refreshReplacement(agentId);
      if (refreshSidebar && host.sessionData.isSessionMutationScopeCurrent(scope)) {
        await host.sessionData.refreshSidebarSessions(agentId);
      }
    } catch (error) {
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
      host.sessionData.publishSessionMutationError(scope, error);
      return "failed";
    }
  }
  return host.sessionData.isSessionMutationScopeCurrent(scope) ? "completed" : "stale";
}

export async function patchSessionRows(
  host: SessionActionHost,
  rows: readonly SessionActionRow[],
  patch: SessionsPatchMutation,
  scope: SidebarSessionMutationScope,
  options: {
    deferListRefresh?: boolean;
    fallback?: () => Promise<SessionRowsPatchResult | null>;
  } = {},
): Promise<SessionRowsPatchResult | null> {
  const dispatched: Array<{
    rows: readonly SessionActionRow[];
    result: SessionsPatchManyResult;
  }> = [];
  let terminalError: unknown = null;
  const sendChunk = (params: SessionsPatchManyParams) =>
    patch.archived === true
      ? scope.client.request<SessionsPatchManyResult>(
          "sessions.patchMany",
          params,
          SESSION_ARCHIVE_REQUEST_OPTIONS,
        )
      : scope.client.request<SessionsPatchManyResult>("sessions.patchMany", params);
  for (let offset = 0; offset < rows.length; offset += SESSIONS_PATCH_MANY_MAX_TARGETS) {
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return null;
    }
    const chunkRows = rows.slice(offset, offset + SESSIONS_PATCH_MANY_MAX_TARGETS);
    const params: SessionsPatchManyParams = {
      targets: chunkRows.map((row) => ({
        key: row.key,
        agentId: sessionRowAgentId(row, scope),
        // Per-target identity: the batch refuses only the rows whose stored session
        // moved, and still applies every row that did not.
        ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
      })),
      patch,
    };
    const access = readSessionMethodAccess(scope.gateway.snapshot, {
      method: "sessions.patchMany",
      params,
    });
    if (!access.allowed) {
      if (dispatched.length === 0 && access.cause === "method-unavailable" && options.fallback) {
        return options.fallback();
      }
      terminalError = access.reason;
      if (dispatched.length === 0) {
        host.sessionData.publishSessionMutationError(scope, access.reason);
      }
      break;
    }
    try {
      const result = await sendChunk(params);
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return null;
      }
      dispatched.push({ rows: chunkRows, result });
    } catch (error) {
      // Metadata-less legacy Gateways allow the optimistic request, then identify
      // this one unsupported method through the canonical Gateway error contract.
      if (dispatched.length === 0 && options.fallback && isLegacyPatchManyMethodRejection(error)) {
        return options.fallback();
      }
      terminalError = error;
      if (dispatched.length === 0) {
        host.sessionData.publishSessionMutationError(scope, error);
      }
      break;
    }
  }
  if (dispatched.length === 0) {
    return null;
  }
  if (!options.deferListRefresh) {
    const refreshResult = await refreshSessionsAfterBatch(host, scope, rows);
    if (refreshResult === "stale") {
      return null;
    }
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return null;
  }
  const errors: string[] = [];
  const gone: SessionActionRow[] = [];
  const reaim: Array<{ row: SessionActionRow; sessionId: string }> = [];
  const collect = (chunkRows: readonly SessionActionRow[], result: SessionsPatchManyResult) =>
    result.outcomes.flatMap((outcome, index) => {
      const row = chunkRows[index];
      if (!outcome.ok) {
        const changed = row ? readSessionChangedTarget(outcome.error) : null;
        if (changed?.currentSessionId && isSessionPresentationPatch(patch)) {
          reaim.push({ row: row!, sessionId: changed.currentSessionId });
        } else if (changed && row) {
          gone.push(row);
        } else {
          errors.push(`${outcome.key}: ${outcome.error.message}`);
        }
        return [];
      }
      if (row?.pinned && patch.archived === true) {
        host.pruneSidebarSessionEntry(row.key);
      }
      return row ? [row] : [];
    });
  const successful = dispatched.flatMap(({ rows: chunkRows, result }) =>
    collect(chunkRows, result),
  );
  // Rows whose identity rotated under them are still the rows the operator picked,
  // so the batch re-aims at the surviving sessions once, in one extra request and
  // without saying anything. Only rows the Gateway reports as gone are accounted for.
  if (reaim.length > 0) {
    const reaimRows = reaim.map(({ row }) => row);
    try {
      const result = await sendChunk({
        targets: reaim.map(({ row, sessionId }) => ({
          key: row.key,
          agentId: sessionRowAgentId(row, scope),
          expectedSessionId: sessionId,
        })),
        patch,
      });
      if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return null;
      }
      successful.push(...collect(reaimRows, result));
    } catch (error) {
      errors.push(formatUiError(error));
    }
  }
  const terminalErrorMessage = terminalError === null ? "" : formatUiError(terminalError);
  if (terminalErrorMessage) {
    errors.push(terminalErrorMessage);
  }
  if (errors.length > 0) {
    host.sessionData.publishSessionMutationError(scope, errors.join("; "));
  }
  return { rows: successful, gone };
}
