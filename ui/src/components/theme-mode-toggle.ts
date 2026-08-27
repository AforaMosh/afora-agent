import { html } from "lit";
import { property } from "lit/decorators.js";
import type { ThemeMode } from "../app/theme.ts";
import { t } from "../i18n/index.ts";
import { AforaLightDomContentsElement } from "../lit/afora-element.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";

export type ThemeModeChangeDetail = {
  mode: ThemeMode;
  element: HTMLElement;
};

class ThemeModeToggle extends AforaLightDomContentsElement {
  @property({ attribute: false }) mode: ThemeMode = "system";

  private readonly handleModeChange = (event: Event) => {
    const mode = this.mode === "system" ? "light" : this.mode === "light" ? "dark" : "system";
    this.dispatchEvent(
      new CustomEvent<ThemeModeChangeDetail>("theme-change", {
        detail: { mode, element: event.currentTarget as HTMLElement },
        bubbles: true,
        composed: true,
      }),
    );
  };

  override render() {
    const labelKey =
      this.mode === "system"
        ? "common.system"
        : this.mode === "light"
          ? "common.light"
          : "common.dark";
    const label = t(labelKey);
    const tooltip = t("common.colorModeOption", { mode: label });

    return html`
      <afora-tooltip .content=${tooltip}>
        <button
          type="button"
          class="theme-mode-toggle"
          aria-label=${tooltip}
          @click=${this.handleModeChange}
        >
          ${this.mode === "system" ? icons.monitor : this.mode === "light" ? icons.sun : icons.moon}
        </button>
      </afora-tooltip>
    `;
  }
}

if (!customElements.get("afora-theme-mode-toggle")) {
  customElements.define("afora-theme-mode-toggle", ThemeModeToggle);
}
