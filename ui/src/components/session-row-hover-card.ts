import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { repoName } from "../lib/session-display.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import {
  formatSessionPullRequestSummary,
  isCloudWorkerPlacementState,
} from "./session-row-badges.ts";
import { presenceViewerLabel, sessionPresenceViewers } from "./viewer-facepile.ts";

/** Cold-open delay; the tooltip provider still opens sibling cards immediately. */
export const SESSION_CARD_COLD_DELAY_MS = 400;

type SessionContextRow = {
  icon: TemplateResult;
  value: string | TemplateResult;
  danger?: boolean;
};

function basename(path: string | undefined): string | undefined {
  const normalized = path?.trim().replace(/[\\/]+$/u, "");
  return normalized ? normalized.split(/[\\/]/u).findLast(Boolean) : undefined;
}

function projectRow(session: SidebarRecentSession): SessionContextRow | undefined {
  const project = session.worktree?.repoRoot
    ? repoName(session.worktree.repoRoot)
    : basename(session.execCwd);
  if (!project) {
    return undefined;
  }
  return { icon: icons.folder, value: project };
}

function cloudRow(session: SidebarRecentSession): SessionContextRow | undefined {
  const state = session.placementState;
  if (!state || !isCloudWorkerPlacementState(state)) {
    return undefined;
  }
  const conflicts = session.workspaceConflictCount ?? 0;
  if (conflicts > 0) {
    return {
      icon: icons.alertTriangle,
      value: t(
        conflicts === 1
          ? "sessionsView.cloudWorkerPlacementConflict"
          : "sessionsView.cloudWorkerPlacementConflicts",
        { count: String(conflicts), state },
      ),
      danger: true,
    };
  }
  return {
    icon: state === "failed" ? icons.alertTriangle : icons.globe,
    value: t("sessionsView.cloudWorkerPlacement", { state }),
    danger: state === "failed",
  };
}

function buildSessionContextRows(params: {
  session: SidebarRecentSession;
  presencePayload?: unknown;
  selfUserId?: string;
  selfInstanceId?: string;
}): SessionContextRow[] {
  const { session } = params;
  const viewers = sessionPresenceViewers(
    params.presencePayload,
    params.selfUserId,
    params.selfInstanceId,
    session.key,
  );
  const rows: (SessionContextRow | undefined)[] = [
    projectRow(session),
    session.worktree?.branch
      ? {
          icon: icons.gitBranch,
          value: session.worktree.branch,
        }
      : undefined,
    viewers.length > 0
      ? {
          icon: icons.eye,
          value: viewers.map(presenceViewerLabel).join(", "),
        }
      : undefined,
    session.visibility === "draft"
      ? {
          icon: icons.eyeOff,
          value: t("newSession.draftDescription"),
        }
      : undefined,
    session.incognito
      ? {
          icon: icons.lock,
          value: t("newSession.incognitoDescription"),
        }
      : undefined,
    session.pullRequest
      ? {
          icon: icons.gitPullRequest,
          value: formatSessionPullRequestSummary(session.pullRequest),
        }
      : undefined,
    cloudRow(session),
  ];
  // Omit state already visible in the row.
  return rows.filter((row) => row !== undefined);
}

function renderSessionContextRow(row: SessionContextRow): TemplateResult {
  return html`<div
    class="session-hover-card__row ${row.danger ? "session-hover-card__row--danger" : ""}"
  >
    <span class="session-hover-card__icon" aria-hidden="true">${row.icon}</span>
    <span class="session-hover-card__text">
      ${typeof row.value === "string"
        ? html`<span class="session-hover-card__value">${row.value}</span>`
        : row.value}
    </span>
  </div>`;
}

/**
 * One card anatomy for every session the sidebar lists, so scanning from a
 * pinned row to a Codex row reads as the same surface following the pointer.
 * A session with no facts beyond its name gets a header and nothing else — an
 * empty body is a truthful answer, and filler invented to avoid it is not.
 */
function renderInformationCard(
  title: string,
  age: string,
  rows: readonly SessionContextRow[],
): TemplateResult {
  return html`<div class="sidebar-hover-card session-hover-card" slot="content">
    <div class="session-hover-card__header">
      <span class="session-hover-card__title">${title}</span>
      ${age ? html`<span class="session-hover-card__age">${age}</span>` : nothing}
    </div>
    ${rows.length === 0
      ? nothing
      : html`<div class="session-hover-card__body">${rows.map(renderSessionContextRow)}</div>`}
  </div>`;
}

export function renderSessionInformationCard(params: {
  session: SidebarRecentSession;
  title: string;
  presencePayload?: unknown;
  selfUserId?: string;
  selfInstanceId?: string;
}): TemplateResult {
  return renderInformationCard(
    params.title,
    formatRelativeTimestamp(params.session.updatedAt, { suffix: false }),
    buildSessionContextRows(params),
  );
}

export function renderCatalogSessionInformationCard(params: {
  title: string;
  age: string;
  cwd?: string;
  branch?: string;
  pullRequest?: SidebarRecentSession["pullRequest"];
}): TemplateResult {
  const rows: SessionContextRow[] = [];
  if (params.cwd) {
    rows.push({ icon: icons.folder, value: basename(params.cwd) ?? params.cwd });
  }
  if (params.branch) {
    rows.push({
      icon: icons.gitBranch,
      value: params.branch,
    });
  }
  if (params.pullRequest) {
    rows.push({
      icon: icons.gitPullRequest,
      value: formatSessionPullRequestSummary(params.pullRequest),
    });
  }
  return renderInformationCard(params.title, params.age, rows);
}
