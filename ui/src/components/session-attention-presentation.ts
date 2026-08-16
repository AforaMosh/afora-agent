import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import type { SidebarSessionAttention } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { resolveSessionAttentionIcon } from "./session-attention-icon-registry.ts";

export function renderSessionAttentionIcon(attention: SidebarSessionAttention) {
  if (attention.kind === "none") {
    return nothing;
  }
  const icon =
    attention.kind === "question"
      ? icons.hand
      : attention.kind === "approval"
        ? icons.key
        : attention.kind === "agent"
          ? resolveSessionAttentionIcon(attention.icon)
          : icons.alertTriangle;
  return html`<span
    class="sidebar-session-attention__icon sidebar-session-attention__icon--${attention.kind}"
    data-session-attention=${attention.kind}
    aria-hidden="true"
    >${icon}</span
  >`;
}

export function sessionAttentionSubtitle(attention: SidebarSessionAttention): string | undefined {
  switch (attention.kind) {
    case "question":
      return t("sessionsView.waitingForAnswer");
    case "approval":
      return t("sessionsView.waitingForApproval");
    case "error":
      return t("sessionsView.runFailedReason", { reason: attention.reason });
    case "agent":
      return attention.note;
    case "none":
      return undefined;
    default:
      return attention satisfies never;
  }
}
