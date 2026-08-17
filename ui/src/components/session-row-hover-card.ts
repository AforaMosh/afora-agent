import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { formatSessionPullRequestSummary } from "./session-row-badges.ts";
import { presenceViewerLabel, projectPresencePayload } from "./viewer-facepile.ts";

export const SESSION_CARD_COLD_DELAY_MS = 400;

type SessionContextRow = {
  icon: TemplateResult;
  label?: string;
  value: string;
};

function renderContextRow(row: SessionContextRow): TemplateResult {
  return html`<div class="session-hover-card__row">
    <span class="session-hover-card__icon" aria-hidden="true">${row.icon}</span>
    <span class="session-hover-card__text">
      ${row.label ? html`<span class="session-hover-card__label">${row.label}</span>` : nothing}
      <span class="session-hover-card__value">${row.value}</span>
    </span>
  </div>`;
}

function renderInformationCard(params: {
  title: string;
  age: string;
  rows: readonly SessionContextRow[];
}): TemplateResult {
  return html`<div class="sidebar-hover-card session-hover-card" slot="content">
    <div class="session-hover-card__header">
      <span class="session-hover-card__title">${params.title}</span>
      ${params.age ? html`<span class="session-hover-card__age">${params.age}</span>` : nothing}
    </div>
    ${params.rows.length === 0
      ? nothing
      : html`<div class="session-hover-card__body">${params.rows.map(renderContextRow)}</div>`}
  </div>`;
}

function workContextRows(subtitle: string | undefined): SessionContextRow[] {
  if (!subtitle) {
    return [];
  }
  const [checkout] = subtitle.split(" · ");
  const [project, branch] = checkout.split(" ⎇ ");
  return [
    project
      ? { icon: icons.folder, label: t("sessionsView.projectLabel"), value: project }
      : undefined,
    branch
      ? { icon: icons.gitBranch, label: t("sessionsView.branchLabel"), value: branch }
      : undefined,
  ].filter((row): row is SessionContextRow => row !== undefined);
}

export function renderSessionInformationCard(params: {
  session: SidebarRecentSession;
  title: string;
  subtitle?: string;
  presencePayload?: unknown;
  selfUserId?: string;
  selfInstanceId?: string;
}): TemplateResult {
  const presence = projectPresencePayload(
    params.presencePayload,
    params.selfUserId,
    params.selfInstanceId,
  );
  const viewers = presence.users.filter(
    (user) => user.id !== presence.selfUserId && user.watchedSessions.includes(params.session.key),
  );
  const rows = workContextRows(params.subtitle);
  const creator = params.session.createdActor?.label ?? params.session.createdActor?.id;
  if (creator) {
    rows.unshift({
      icon: icons.circleUser,
      label: t("sessionsView.createdByLabel"),
      value: creator,
    });
  }
  if (viewers.length > 0) {
    rows.push({
      icon: icons.eye,
      label: t("presence.rosterTitle"),
      value: viewers.map(presenceViewerLabel).join(", "),
    });
  }
  if (params.session.pullRequest) {
    rows.push({
      icon: icons.gitPullRequest,
      value: formatSessionPullRequestSummary(params.session.pullRequest),
    });
  }
  return renderInformationCard({
    title: params.title,
    age: formatRelativeTimestamp(params.session.updatedAt, { suffix: false }),
    rows,
  });
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
    rows.push({ icon: icons.folder, label: t("sessionsView.projectLabel"), value: params.cwd });
  }
  if (params.branch) {
    rows.push({
      icon: icons.gitBranch,
      label: t("sessionsView.branchLabel"),
      value: params.branch,
    });
  }
  if (params.pullRequest) {
    rows.push({
      icon: icons.gitPullRequest,
      value: formatSessionPullRequestSummary(params.pullRequest),
    });
  }
  return renderInformationCard({ title: params.title, age: params.age, rows });
}
