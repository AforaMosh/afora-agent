import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import {
  renderSessionAttentionIcon,
  renderSessionState,
  renderSessionUnreadState,
} from "./session-attention-presentation.ts";
import {
  renderSessionGlyph,
  renderSessionUnreadBadge,
  type SessionGlyphContent,
} from "./session-glyph.ts";
import { resolveSessionIconGlyph } from "./session-icon-glyph-registry.ts";
import type { SessionPullRequestIndicatorState } from "./session-menu-work.ts";
import { renderSessionOwnerChip, type SessionCreatedActor } from "./session-owner-chip.ts";

function renderChildUnreadBadge(session: SidebarRecentSession): SessionGlyphContent {
  return session.isChild && session.unread ? renderSessionUnreadBadge() : nothing;
}

function pullRequestStateLabel(
  pullRequestState: Exclude<SessionPullRequestIndicatorState, "none">,
) {
  return pullRequestState === "open"
    ? t("sessionsView.openPullRequest")
    : t("chat.pullRequests.merged");
}

function renderPullRequestIndicator(pullRequestState: SessionPullRequestIndicatorState) {
  if (pullRequestState === "none") {
    return nothing;
  }
  const label = pullRequestStateLabel(pullRequestState);
  return html`<span
    class="sidebar-session-pr-indicator sidebar-session-pr-indicator--${pullRequestState}"
    data-session-pr-state=${pullRequestState}
    role="img"
    aria-label=${label}
    title=${label}
    >${pullRequestState === "open" ? icons.gitPullRequest : icons.gitMerge}</span
  >`;
}

function renderSessionTrailingState(
  session: SidebarRecentSession,
  pullRequestState: SessionPullRequestIndicatorState,
) {
  const sessionState = renderSessionState(session, false);
  const concurrentUnreadState = session.hasActiveRun ? renderSessionUnreadState(session) : nothing;
  if (sessionState === nothing && concurrentUnreadState === nothing) {
    return nothing;
  }
  return html`${sessionState} ${concurrentUnreadState}`;
}

function renderPersistentSessionIcon(icon: string) {
  const glyph = resolveSessionIconGlyph(icon);
  return glyph
    ? html`<span class="session-glyph__icon" aria-hidden="true">${glyph}</span>`
    : html`<span class="session-glyph__emoji" aria-hidden="true">${icon}</span>`;
}

type SessionLeadingArtwork = {
  circular?: boolean;
  content: SessionGlyphContent;
  renderedOwnerId?: string;
};

function resolveSessionLeadingArtwork(
  session: SidebarRecentSession,
  ownerActor: SessionCreatedActor | null | undefined,
  attribution: "created" | "archived",
  ownerViewing?: boolean,
): SessionLeadingArtwork | null {
  if (session.attention.kind !== "none") {
    return { content: renderSessionAttentionIcon(session.attention) };
  }
  if (session.icon) {
    return { content: renderPersistentSessionIcon(session.icon) };
  }
  const ownerId = ownerActor?.id?.trim();
  if (!session.isChild && ownerId) {
    return {
      circular: true,
      content: renderSessionOwnerChip(ownerActor, "row", attribution, ownerViewing),
      renderedOwnerId: ownerId,
    };
  }
  return null;
}

export function describeSessionTrailingState(
  session: SidebarRecentSession,
  pullRequestState: SessionPullRequestIndicatorState,
) {
  return [
    session.forkSource ? t("sessionsView.forkedSession") : "",
    pullRequestState === "none" ? "" : pullRequestStateLabel(pullRequestState),
    session.hasActiveRun ? t("sessionsView.activeRun") : "",
    session.unread ? t("sessionsView.unread") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function renderSessionLeadingState(
  session: SidebarRecentSession,
  pullRequestState: SessionPullRequestIndicatorState,
  ownerActor: SessionCreatedActor | null | undefined,
  attribution: "created" | "archived",
  ownerViewing?: boolean,
): {
  running: boolean;
  leadingIndicator: TemplateResult | typeof nothing;
  trailingIndicator: TemplateResult | typeof nothing;
  renderedOwnerId?: string;
} {
  const running = session.hasActiveRun;
  const trailingIndicator = session.isChild
    ? nothing
    : renderSessionTrailingState(session, pullRequestState);
  const artwork = resolveSessionLeadingArtwork(session, ownerActor, attribution, ownerViewing);
  if (pullRequestState !== "none") {
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        content: renderPullRequestIndicator(pullRequestState),
        running: session.isChild && running,
        badge: renderChildUnreadBadge(session),
        overlay: artwork ? artwork.content : nothing,
      }),
      trailingIndicator,
      ...(artwork?.renderedOwnerId ? { renderedOwnerId: artwork.renderedOwnerId } : {}),
    };
  }
  // Transient attention outranks persistent artwork, but PR state remains the
  // primary glyph so a forked PR never regresses to duplicate branch icons.
  if (artwork) {
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        content: artwork.content,
        running: session.isChild && running,
        circular: artwork.circular,
        badge: renderChildUnreadBadge(session),
      }),
      trailingIndicator,
      renderedOwnerId: artwork.renderedOwnerId,
    };
  }
  if (session.isChild) {
    if (running) {
      return {
        running,
        leadingIndicator: renderSessionState(session),
        trailingIndicator,
      };
    }
    const sessionState = renderSessionState(session);
    return {
      running,
      leadingIndicator: sessionState,
      trailingIndicator,
    };
  }

  return {
    running,
    leadingIndicator: nothing,
    trailingIndicator,
  };
}
