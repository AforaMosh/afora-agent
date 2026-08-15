import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { NavigationRouteId } from "../app-navigation.ts";
import { sessionHasPendingApproval } from "../app/approval-presentation.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import type { AuthenticatedUser } from "../app/user-profile.ts";
import { t } from "../i18n/index.ts";
import { sessionHasBoard } from "../lib/board/provider.ts";
import { handleContextMenuEvent } from "../lib/keyboard-shortcuts.ts";
import { createOverflowFadeRef } from "../lib/overflow-fade.ts";
import { restSessionRow, revealSessionRow } from "../lib/session-row-reveal.ts";
import { writeSessionDragData } from "../lib/sessions/drag.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import type {
  CatalogBackingSessionDisplay,
  CatalogSessionMenuRequest,
} from "./app-sidebar-session-catalogs.ts";
import { formatSidebarTimestamp } from "./app-sidebar-session-catalogs.ts";
import {
  rowDemandsVisibility,
  sidebarSessionStateId,
  type SidebarRecentSession,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import type { SessionDataController } from "./session-data-controller.ts";
import type { SessionPullRequestIndicatorState } from "./session-menu-work.ts";
import type { SessionOrganizerController } from "./session-organizer-controller.ts";
import {
  describeSessionPrimaryState,
  resolveSessionPrimaryState,
} from "./session-primary-state.ts";
import {
  describeSessionWorktreePullRequest,
  renderSessionRowBadges,
  renderSessionWorktreePullRequest,
} from "./session-row-badges.ts";
import { renderSessionRowEndcap } from "./session-row-endcap.ts";
import {
  renderSessionInformationCard,
  SESSION_CARD_COLD_DELAY_MS,
} from "./session-row-hover-card.ts";
import { renderSessionRowOrigin } from "./session-row-origin.ts";
import { renderSessionOwnerChip } from "./session-owner-chip.ts";
import {
  renderSidebarSessionSubtitle,
  resolveSidebarSessionSubtitle,
} from "./session-row-subtitle.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.ts";
import {
  isSessionPresenceIdentityWatching,
  sessionPresenceViewers,
} from "./viewer-facepile.ts";

const SIDEBAR_VISIBLE_CHILD_SESSION_LIMIT = 4;

export interface SessionListHost {
  readonly sessionDataContext:
    | {
        // `hello`/`connection` are the credential candidates the authenticated
        // workspace-icon route needs; the sidebar reads them, never stores them.
        gateway: {
          snapshot: {
            selfUser?: AuthenticatedUser | null;
            hello?: { auth?: { deviceToken?: string | null } | null } | null;
          };
          connection: { token?: string | null; password?: string | null };
        };
      }
    | undefined;
  readonly basePath: string;
  readonly sidebarLiveActivity: boolean;
  readonly sidebarNarrationLines: ReadonlyMap<string, string>;
  readonly sidebarObserverDigests: ReadonlyMap<string, SessionObserverDigest>;
  readonly selectedSessionKeys: ReadonlySet<string>;
  readonly connected: boolean;
  readonly sessionData: Pick<
    SessionDataController,
    | "approvalBadgeSnapshot"
    | "loadMoreSessionCatalog"
    | "presenceInstanceId"
    | "presencePayload"
    | "refreshSessionCatalogs"
    | "sessionCatalogRefreshStatus"
    | "sessionMutationError"
  >;
  readonly fullyShownChildSessionKeys: ReadonlySet<string>;
  readonly sessionsGrouping: SidebarSessionsGrouping;
  readonly collapsedSessionSections: ReadonlySet<string>;
  readonly sessionOrganizer: Pick<
    SessionOrganizerController,
    | "draggingSidebarSection"
    | "draggingSessionKey"
    | "sessionDropTarget"
    | "sidebarSectionDropTarget"
    | "sessionListRemovalDrop"
  >;
  readonly sidebarMenus: Pick<
    SidebarMenusController,
    | "catalogViewMenuPosition"
    | "openCatalogViewMenu"
    | "openSessionGroupMenu"
    | "openSessionMenu"
    | "sessionGroupMenu"
    | "sessionMenu"
    | "sessionSortMenuPosition"
    | "toggleCatalogViewMenu"
    | "toggleSessionSortMenu"
  >;
  readonly sessionsStatusFilter: SidebarSessionStatusFilter;
  readonly sessionCreatorFilterActive: boolean;
  readonly sessionOwnershipVisible: boolean;
  readonly onOpenNewSession?: (agentId: string, target?: NewSessionTarget) => void;
  readonly onNavigate?: (
    routeId: NavigationRouteId,
    options?: ApplicationNavigationOptions,
  ) => void;

  sessionPullRequestIndicatorState(
    sessionKey: string,
    worktreeId: string,
  ): SessionPullRequestIndicatorState;
  isSessionChildrenExpanded(session: SidebarRecentSession): boolean;
  startSessionDrag(session: SidebarRecentSession): void;
  finishSessionDrag(): void;
  handleSessionRowClick(event: MouseEvent, session: SidebarRecentSession): void;
  toggleSessionChildren(session: SidebarRecentSession): void;
  toggleSessionPin(session: SidebarRecentSession): void;
  toggleSessionMenu(session: SidebarRecentSession, trigger: HTMLElement): void;
  showMoreChildren(sessionKey: string): void;
  sectionDragOver(event: DragEvent, sectionId: string, group?: string): void;
  sectionDragLeave(event: DragEvent, sectionId: string, group?: string): void;
  sectionDrop(event: DragEvent, sectionId: string, group?: string): void;
  startSidebarSectionDrag(sectionId: string): void;
  finishSidebarSectionDrag(): void;
  toggleSection(sectionId: string): void;
  openNewSession(target?: NewSessionTarget): void;
  readNewSessionAccess(): import("../lib/session-method-access.ts").SessionMethodAccess;
  readSessionMutationAccess(request: {
    method: string;
    params?: unknown;
    requiredScope?: "operator.write" | "operator.admin";
  }): import("../lib/session-method-access.ts").SessionMethodAccess;
  requestOpenNewSession(agentId: string, target?: NewSessionTarget): void;
  setVisibleSessionLimit(sectionId: string, limit: number): void;
  clearSessionSelection(): void;
  handleSessionListDragOver(event: DragEvent): void;
  handleSessionListDragLeave(event: DragEvent): void;
  handleSessionListDrop(event: DragEvent): void;
  dismissSessionMutationError(): void;
  openCatalogMenu(
    request: CatalogSessionMenuRequest,
    x: number,
    y: number,
    trigger?: HTMLElement,
  ): void;
}

export function visibleSessionChildren(params: {
  session: SidebarRecentSession;
  fullyShownChildSessionKeys: ReadonlySet<string>;
}): readonly SidebarRecentSession[] {
  const showAllChildren = params.fullyShownChildSessionKeys.has(params.session.key);
  // Active, running, and attention-bearing branches must bypass the quiet-child cap.
  return showAllChildren
    ? params.session.children
    : params.session.children.filter(
        (child, index) =>
          index < SIDEBAR_VISIBLE_CHILD_SESSION_LIMIT || rowDemandsVisibility(child),
      );
}

export function renderRecentSession(params: {
  host: SessionListHost;
  session: SidebarRecentSession;
  display?: CatalogBackingSessionDisplay;
  listItem?: boolean;
  /** Project heading this row already sits under, if any. */
  project?: string;
  /** Glyph shown ahead of the title; set for rows that sit among Pages entries. */
  lead?: TemplateResult;
}) {
  const { host, session, display, listItem = true } = params;
  const pinAccess = host.readSessionMutationAccess({
    method: "sessions.patch",
    params: { key: session.key, pinned: !session.pinned },
  });
  const label = display?.label ?? session.label;
  const subtitleValue = resolveSidebarSessionSubtitle({
    session,
    hasDisplay: display !== undefined,
    displaySubtitle: display?.subtitle,
    displayWork: display?.work,
    sidebarLiveActivity: host.sidebarLiveActivity,
    narrationLine: host.sidebarNarrationLines.get(session.key),
    observerDigest: host.sidebarObserverDigests.get(session.key) ?? null,
  });
  const { narration } = subtitleValue;
  const pullRequestState = session.worktree
    ? host.sessionPullRequestIndicatorState(session.key, session.worktree.id)
    : "none";
  const ownerAttribution = host.sessionsStatusFilter === "archived" ? "archived" : "created";
  const ownerActor = host.sessionOwnershipVisible
    ? host.sessionsStatusFilter === "archived"
      ? session.archivedBy
      : session.createdActor
    : undefined;
  const ownerId = ownerActor?.id?.trim();
  const ownerViewing = isSessionPresenceIdentityWatching(
    host.sessionData.presencePayload,
    host.sessionDataContext?.gateway.snapshot.selfUser?.id,
    host.sessionData.presenceInstanceId,
    session.key,
    ownerId,
  );
  const ownerIndicator = renderSessionOwnerChip(
    ownerActor,
    "row",
    ownerAttribution,
    ownerViewing,
  );
  const primaryState = resolveSessionPrimaryState(session);
  const running = primaryState.kind === "running";
  const stateDescription = describeSessionPrimaryState(primaryState);
  const meta = display?.meta ?? formatSidebarTimestamp(session.updatedAt);
  const rowMeta = session.pinned ? "" : meta;
  const stateId = primaryState.kind === "none" ? undefined : sidebarSessionStateId(session.key);
  const origin = session.isChild
    ? nothing
    : renderSessionRowOrigin({
        draft: session.visibility === "draft",
        incognito: session.incognito === true,
      });
  const openMenuFromEvent = session.isChild
    ? undefined
    : (event: MouseEvent | KeyboardEvent) =>
        handleContextMenuEvent(
          event,
          (event.currentTarget as HTMLElement).querySelector("[data-session-menu]"),
          (trigger, x, y) => host.sidebarMenus.openSessionMenu(session, x, y, trigger),
        );
  const title = [
    display?.title ?? [label, narration, rowMeta].filter(Boolean).join(" · "),
    stateDescription,
    describeSessionWorktreePullRequest(pullRequestState),
  ]
    .filter(Boolean)
    .join(" · ");
  const pinLabel = `${t(session.pinned ? "sessionsView.unpinSession" : "sessionsView.pinSession")}: ${label}`;
  const menuLabel = `${t("chat.sidebar.openSessionMenu")}: ${label}`;
  const menuOpen = host.sidebarMenus.sessionMenu?.session.key === session.key;
  const rowClass = [
    "sidebar-recent-session",
    "session-row-host",
    menuOpen ? "session-row-host--menu-open" : "",
    session.isChild ? "sidebar-recent-session--child" : "",
    session.archived ? "sidebar-session--archived" : "",
    session.visuallyActive ? "sidebar-recent-session--active" : "",
    host.selectedSessionKeys.has(session.key) ? "sidebar-recent-session--selected" : "",
    session.pinned ? "session-row-host--pinned" : "",
    running ? "session-row-host--running" : "",
    session.visibility === "draft" ? "session-row-host--draft" : "",
    session.visibility === "draft"
      ? session.draftOwnedBySelf
        ? "session-row-host--draft-owner"
        : "session-row-host--draft-other"
      : "",
    session.attention.kind === "error"
      ? "sidebar-recent-session--attention-danger"
      : session.attention.kind !== "none"
        ? "sidebar-recent-session--attention-amber"
        : "",
    host.sessionOrganizer.draggingSessionKey === session.key
      ? "sidebar-recent-session--dragging"
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const childrenExpanded = host.isSessionChildrenExpanded(session);
  const groupWriteAccess = host.readSessionMutationAccess({
    method: "sessions.groups.put",
    requiredScope: "operator.write",
  });
  const rowDraggable = !session.isChild && groupWriteAccess.allowed;
  const boardIndicator = sessionHasBoard(session.key)
    ? html`<span
        class="sidebar-board-glyph"
        role="img"
        aria-label=${t("sessionsView.dashboardAvailable")}
        title=${t("sessionsView.dashboardAvailable")}
        >${icons.layoutDashboard}</span
      >`
    : nothing;
  const viewerFacepile = html`<openclaw-viewer-facepile
    .presencePayload=${host.sessionData.presencePayload}
    .selfUserId=${host.sessionDataContext?.gateway.snapshot.selfUser?.id}
    .selfInstanceId=${host.sessionData.presenceInstanceId}
    .sessionKey=${session.key}
    .excludeUserId=${ownerId}
    .maxVisible=${session.pinned ? 3 : 2}
    variant="session"
  ></openclaw-viewer-facepile>`;
  const rowBadges = renderSessionRowBadges({
    ...session,
    // An active row shows the composer itself, so its own draft is not news.
    hasComposerDraft: session.hasComposerDraft === true && !session.visuallyActive,
    maxVisible: session.pinned ? undefined : 2,
    pullRequest: session.pullRequest ?? display?.pullRequest,
    // The subtitle already reads "Waiting for approval" whenever the row
    // owns that attention; a second glyph says nothing new.
    hasApproval:
      session.attention.kind !== "approval" &&
      sessionHasPendingApproval(host.sessionData.approvalBadgeSnapshot(), session.key),
  });
  const hasViewers =
    sessionPresenceViewers(
      host.sessionData.presencePayload,
      host.sessionDataContext?.gateway.snapshot.selfUser?.id,
      host.sessionData.presenceInstanceId,
      session.key,
    ).some((viewer) => viewer.id !== ownerId);
  const hasRestSummary =
    primaryState.kind !== "none" ||
    sessionHasBoard(session.key) ||
    pullRequestState !== "none" ||
    rowBadges !== nothing;
  const endcap = renderSessionRowEndcap({
    state: primaryState,
    stateId,
    metadata: session.pinned
      ? renderSessionWorktreePullRequest(pullRequestState)
      : html`${boardIndicator}${rowBadges}${renderSessionWorktreePullRequest(pullRequestState)}`,
    legacy: session.pinned || session.isChild,
    actionOnly: !hasRestSummary,
    actions: session.isChild
      ? nothing
      : html`<span class="session-row-actions">
          <button
            class="session-action session-action--pin"
            data-sidebar-session-pin="true"
            type="button"
            title=${pinAccess.allowed ? pinLabel : pinAccess.reason}
            aria-label=${pinLabel}
            ?disabled=${!pinAccess.allowed}
            @click=${() => host.toggleSessionPin(session)}
          >
            ${icons.pin}
          </button>
          <button
            class="session-action"
            data-session-menu="true"
            type="button"
            title=${menuLabel}
            aria-label=${menuLabel}
            aria-haspopup="menu"
            aria-expanded=${String(menuOpen)}
            @click=${(event: MouseEvent) => {
              event.stopPropagation();
              const trigger = event.currentTarget as HTMLElement;
              host.toggleSessionMenu(session, trigger);
            }}
          >
            ${icons.moreHorizontal}
          </button>
        </span>`,
  });
  const nameContent = html`${session.archived
    ? html`<span
        class="sidebar-session__archive-glyph"
        aria-label=${t("sessionsView.archived")}
        title=${t("sessionsView.archived")}
        >${icons.archive}</span
      >`
    : nothing}${label}`;
  const row = html`
    <openclaw-tooltip
      class="sidebar-hover-tooltip session-hover-tooltip"
      delay=${SESSION_CARD_COLD_DELAY_MS}
      placement="right"
      role=${ifDefined(listItem ? "listitem" : undefined)}
      ?suppressed=${menuOpen}
    >
      <div
        class=${rowClass}
        data-session-key=${session.key}
        data-session-unread=${session.unread ? "true" : nothing}
        data-session-attention=${session.attention.kind === "none"
          ? nothing
          : session.attention.kind}
        data-session-manageable=${!session.pinned && !session.isChild ? "true" : "false"}
        data-session-action-only=${!hasRestSummary ? "true" : nothing}
        draggable=${rowDraggable ? "true" : "false"}
        title=${!session.isChild && !groupWriteAccess.allowed ? groupWriteAccess.reason : nothing}
        @dragstart=${!rowDraggable
          ? nothing
          : (event: DragEvent) => {
              if (event.dataTransfer) {
                writeSessionDragData(event.dataTransfer, session.key);
                host.startSessionDrag(session);
              }
            }}
        @dragend=${!rowDraggable
          ? nothing
          : () => {
              host.finishSessionDrag();
            }}
        @contextmenu=${openMenuFromEvent ?? nothing}
        @keydown=${openMenuFromEvent ?? nothing}
        @mouseenter=${session.pinned
          ? (event: MouseEvent) => revealSessionRow(event.currentTarget as HTMLElement)
          : nothing}
        @mouseleave=${session.pinned
          ? (event: MouseEvent) =>
              restSessionRow(event.currentTarget as HTMLElement, event.relatedTarget as Node | null)
          : nothing}
        @focusin=${session.pinned
          ? (event: FocusEvent) => revealSessionRow(event.currentTarget as HTMLElement)
          : nothing}
        @focusout=${session.pinned
          ? (event: FocusEvent) =>
              restSessionRow(event.currentTarget as HTMLElement, event.relatedTarget as Node | null)
          : nothing}
      >
        <a
          href=${session.href}
          class="sidebar-recent-session__link"
          draggable="false"
          aria-label=${title}
          aria-current=${session.visuallyActive ? "page" : nothing}
          aria-describedby=${stateId ?? nothing}
          @click=${(event: MouseEvent) => host.handleSessionRowClick(event, session)}
        >
          <span class="sidebar-session-indicator"
            >${params.lead
              ? html`<span class="nav-item__icon" aria-hidden="true">${params.lead}</span>`
              : ownerIndicator}</span
          >
          <span class="sidebar-recent-session__text">
            <span class="sidebar-recent-session__title">
              ${origin}
              ${session.pinned
                ? html`<span class="sidebar-recent-session__name hover-marquee"
                    >${nameContent}</span
                  >`
                : html`<span
                    class="sidebar-recent-session__name"
                    ${ref(createOverflowFadeRef({ revealTrailingActions: !session.isChild }))}
                    ><span class="sidebar-recent-session__name-content">${nameContent}</span></span
                  >`}
            </span>
            ${session.isChild
              ? nothing
              : renderSidebarSessionSubtitle(subtitleValue, params.project)}
          </span>
          ${session.pinned ? html`${boardIndicator}${rowBadges}` : nothing}
        </a>
        ${session.childSessionKeys.length > 0
          ? html`<button
              class="sidebar-child-session-toggle ${session.runningChildCount > 0
                ? "sidebar-child-session-toggle--running"
                : session.failedChildCount > 0
                  ? "sidebar-child-session-toggle--failed"
                  : ""}"
              type="button"
              data-child-session-toggle=${session.key}
              aria-expanded=${String(childrenExpanded)}
              aria-label=${t(
                childrenExpanded
                  ? "sessionsView.hideChildSessions"
                  : "sessionsView.showChildSessions",
                { count: String(session.childSessionKeys.length), session: label },
              )}
              @click=${() => host.toggleSessionChildren(session)}
            >
              <span class="sidebar-child-session-toggle__icon" aria-hidden="true"
                >${childrenExpanded ? icons.chevronDown : icons.chevronRight}</span
              >
              ${childrenExpanded
                ? nothing
                : html`<span class="sidebar-child-session-toggle__count"
                    >${session.childSessionKeys.length}</span
                  >`}
            </button>`
          : nothing}
        <!-- The endcap is the row's trailing rail, so it stays last: nothing pins
        it, and a sibling rendered after it pushes that row's state inboard while
        childless rows keep the true edge. -->
        ${endcap}
      </div>
      ${session.isChild
        ? nothing
        : renderSessionInformationCard({
            session,
            title: label,
            presencePayload: host.sessionData.presencePayload,
            selfUserId: host.sessionDataContext?.gateway.snapshot.selfUser?.id,
            selfInstanceId: host.sessionData.presenceInstanceId,
          })}
    </openclaw-tooltip>
  `;
  // Reveal state mutates the row DOM; keying prevents cross-session reuse.
  return keyed(session.key, row);
}

export function renderSessionTree(params: {
  host: SessionListHost;
  session: SidebarRecentSession;
  listItem?: boolean;
  project?: string;
  lead?: TemplateResult;
}): TemplateResult {
  const { host, session, listItem = true } = params;
  const expanded = host.isSessionChildrenExpanded(session);
  const visibleChildren = visibleSessionChildren({
    session,
    fullyShownChildSessionKeys: host.fullyShownChildSessionKeys,
  });
  const hiddenChildCount = session.children.length - visibleChildren.length;
  return html`<div
    class="sidebar-session-tree"
    data-session-tree=${session.key}
    role=${ifDefined(listItem ? "listitem" : undefined)}
  >
    ${renderRecentSession({
      host,
      session,
      listItem: false,
      project: params.project,
      lead: params.lead,
    })}
    ${expanded
      ? html`<div class="sidebar-session-tree__children">
          ${visibleChildren.length > 0
            ? html`<div
                class="sidebar-session-tree__list"
                role=${ifDefined(listItem ? "list" : undefined)}
                aria-label=${ifDefined(listItem ? t("sessionsView.childSessions") : undefined)}
              >
                ${visibleChildren.map((child) =>
                  renderSessionTree({ host, session: child, listItem }),
                )}
              </div>`
            : nothing}
          ${hiddenChildCount > 0
            ? html`<button
                class="sidebar-session-tree__show-more"
                type="button"
                data-show-more-children=${session.key}
                aria-label=${t("sessionsView.showMoreChildren", {
                  count: String(hiddenChildCount),
                })}
                @click=${() => host.showMoreChildren(session.key)}
              >
                ${t("sessionsView.showMoreChildren", { count: String(hiddenChildCount) })}
              </button>`
            : nothing}
          ${session.loadingChildren && session.children.length === 0
            ? html`<span class="sidebar-session-tree__loading">${t("common.loading")}</span>`
            : nothing}
        </div>`
      : nothing}
  </div>`;
}
