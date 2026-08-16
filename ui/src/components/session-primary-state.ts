import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

/** The one operational state a session row reports. */
export type SessionPrimaryState =
  | { kind: "none" }
  | { kind: "running" }
  | { kind: "blocked" }
  | { kind: "unread" };

export function resolveSessionPrimaryState(session: SidebarRecentSession): SessionPrimaryState {
  // A live run makes prior state stale.
  if (session.hasActiveRun) {
    return { kind: "running" };
  }
  // Opening a session consumes its transient attention indicator.
  if (session.visuallyActive) {
    return { kind: "none" };
  }
  // Canonical attention prevents dismissed raw status from resurfacing.
  if (session.attention.kind !== "none") {
    return { kind: "blocked" };
  }
  return session.unread ? { kind: "unread" } : { kind: "none" };
}

export function describeSessionPrimaryState(state: SessionPrimaryState): string {
  switch (state.kind) {
    case "running":
      return t("sessionsView.activeRun");
    case "blocked":
      return t("sessionsView.attentionRequired");
    case "unread":
      return t("sessionsView.unread");
    case "none":
      return "";
    default:
      return state satisfies never;
  }
}

export function renderSessionPrimaryState(
  state: SessionPrimaryState,
): TemplateResult | typeof nothing {
  if (state.kind === "none") {
    return nothing;
  }
  // The endcap owns the accessible name.
  return state.kind === "running"
    ? html`<span class="session-run-spinner"></span>`
    : html`<span class="session-state-dot session-state-dot--${state.kind}"></span>`;
}
