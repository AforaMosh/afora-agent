import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

export function renderSessionLeadingIdentity(params: {
  owner: TemplateResult | typeof nothing;
  incognito: boolean;
  draft: boolean;
}): TemplateResult | typeof nothing {
  const hasOwner = params.owner !== nothing;
  if (!hasOwner && !params.incognito && !params.draft) {
    return nothing;
  }
  const fallbackKind = params.incognito ? "incognito" : "draft";
  return html`<span class="session-row-leading-identity">
    ${hasOwner
      ? params.owner
      : html`<span
          class="session-row-state-avatar session-row-state-avatar--${fallbackKind}"
          role="img"
          aria-label=${t(
            fallbackKind === "incognito" ? "sessionsView.incognito" : "chat.sessionSharing.draft",
          )}
          title=${t(
            fallbackKind === "incognito" ? "sessionsView.incognito" : "chat.sessionSharing.draft",
          )}
          >${fallbackKind === "incognito" ? icons.hatGlasses : icons.messageCircleDashed}</span
        >`}
    ${hasOwner && params.incognito
      ? html`<span
          class="session-row-state-badge session-row-state-badge--incognito"
          role="img"
          aria-label=${t("sessionsView.incognito")}
          title=${t("sessionsView.incognito")}
          >${icons.hatGlasses}</span
        >`
      : nothing}
    ${(hasOwner || params.incognito) && params.draft
      ? html`<span
          class="session-row-state-badge session-row-state-badge--draft"
          role="img"
          aria-label=${t("chat.sessionSharing.draft")}
          title=${t("chat.sessionSharing.draft")}
          >${icons.messageCircleDashed}</span
        >`
      : nothing}
  </span>`;
}
