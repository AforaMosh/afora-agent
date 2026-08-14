import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

/**
 * Privacy qualifiers stay inline at the start of the title while creator
 * identity remains in the row's dedicated leading column.
 */
export function renderSessionRowOrigin(params: {
  draft: boolean;
  incognito: boolean;
}): TemplateResult | typeof nothing {
  if (!params.draft && !params.incognito) {
    return nothing;
  }
  return html`<span class="session-row-origin">
    ${params.incognito
      ? html`<span
          class="session-row-origin__qualifier"
          role="img"
          aria-label=${t("sessionsView.incognito")}
          title=${t("sessionsView.incognito")}
          >${icons.hatGlasses}</span
        >`
      : nothing}
    ${params.draft
      ? html`<span class="session-row-origin__draft">${t("chat.sessionSharing.draft")}</span>`
      : nothing}
  </span>`;
}
