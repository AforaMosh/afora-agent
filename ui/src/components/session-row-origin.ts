import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

export function renderSessionLeadingIdentity(params: {
  owner: TemplateResult | typeof nothing;
  incognito: boolean;
}): TemplateResult | typeof nothing {
  const hasOwner = params.owner !== nothing;
  if (!hasOwner && !params.incognito) {
    return nothing;
  }
  return html`<span class="session-row-leading-identity">
    ${hasOwner
      ? params.owner
      : html`<span
          class="session-row-state-avatar session-row-state-avatar--incognito"
          role="img"
          aria-label=${t("sessionsView.incognito")}
          title=${t("sessionsView.incognito")}
          >${icons.hatGlasses}</span
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
  </span>`;
}

export function renderSessionRowMarkers(params: {
  draft: boolean;
}): TemplateResult | typeof nothing {
  if (!params.draft) {
    return nothing;
  }
  return html`<span class="session-row-markers">
    <span class="session-row-marker session-row-marker--draft"
      >${t("chat.sessionSharing.draft")}</span
    >
  </span>`;
}
