import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

/** Privacy and draft state stay attached to the title they qualify; creator
 *  identity remains in the dedicated leading column outside this group. */
export function renderSessionRowMarkers(params: {
  draft: boolean;
  incognito: boolean;
}): TemplateResult | typeof nothing {
  if (!params.draft && !params.incognito) {
    return nothing;
  }
  return html`<span class="session-row-markers">
    ${params.incognito
      ? html`<span
          class="session-row-marker session-row-marker--incognito"
          role="img"
          aria-label=${t("sessionsView.incognito")}
          title=${t("sessionsView.incognito")}
          >${icons.hatGlasses}</span
        >`
      : nothing}
    ${params.draft
      ? html`<span class="session-row-marker session-row-marker--draft"
          >${t("chat.sessionSharing.draft")}</span
        >`
      : nothing}
  </span>`;
}
