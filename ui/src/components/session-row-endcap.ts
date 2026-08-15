import { html, nothing, type TemplateResult } from "lit";
import {
  describeSessionPrimaryState,
  renderSessionPrimaryState,
  type SessionPrimaryState,
} from "./session-primary-state.ts";

/**
 * The single trailing owner of a session row: passive metadata first, then the
 * one operational state, with management actions overlaying the same cell. It
 * exists so state has exactly one home no matter which list rendered the row.
 */
export function renderSessionRowEndcap(params: {
  state: SessionPrimaryState;
  stateId: string | undefined;
  metadata?: TemplateResult | typeof nothing;
  actions?: TemplateResult | typeof nothing;
  legacy?: boolean;
  actionOnly?: boolean;
}): TemplateResult {
  const state = renderSessionPrimaryState(params.state);
  const stateContent =
    state === nothing
      ? nothing
      : html`<span
          class="session-row-state"
          id=${params.stateId ?? nothing}
          role="img"
          aria-label=${describeSessionPrimaryState(params.state)}
          >${state}</span
        >`;
  if (params.legacy) {
    return html`<span class="sidebar-recent-session__aside session-row-aside">
      ${stateContent} ${params.metadata ?? nothing} ${params.actions ?? nothing}
    </span>`;
  }
  return html`<span
    class="session-row-endcap ${params.actionOnly ? "session-row-endcap--action-only" : ""}"
  >
    <span class="session-row-endcap__swap">
      <span class="session-row-endcap__rest-summary"
        >${params.metadata ?? nothing}${stateContent}</span
      >
      <span class="session-row-endcap__management">${params.actions ?? nothing}</span>
    </span>
  </span>`;
}
