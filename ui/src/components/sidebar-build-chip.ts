import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { pathForRoute } from "../app-route-paths.ts";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { AforaLightDomContentsElement } from "../lit/afora-element.ts";
import {
  formatBuildChipText,
  formatSettingsBuildLabel,
  renderSidebarServerDetails,
} from "./sidebar-build-chip-format.ts";
import "./tooltip.ts";

class SidebarBuildChip extends AforaLightDomContentsElement {
  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) gatewayVersion: string | null = null;
  @property({ attribute: false }) onNavigate?: (routeId: "about") => void;
  @property({ attribute: false }) variant: "compact" | "settings" = "compact";

  override render() {
    const text =
      this.variant === "settings"
        ? formatSettingsBuildLabel(CONTROL_UI_BUILD_INFO, this.gatewayVersion)
        : formatBuildChipText(CONTROL_UI_BUILD_INFO);
    if (!text) {
      return nothing;
    }
    return html`
      <afora-tooltip class="sidebar-hover-tooltip">
        <a
          class="sidebar-footer-build"
          href=${pathForRoute("about", this.basePath)}
          aria-label=${t("aboutPage.artifactDetails")}
          @click=${(event: MouseEvent) => {
            if (!shouldHandleNavigationClick(event)) {
              return;
            }
            event.preventDefault();
            this.onNavigate?.("about");
          }}
          >${text}</a
        >
        <div slot="content" class="sidebar-hover-card sidebar-build-hover-card">
          ${renderSidebarServerDetails(CONTROL_UI_BUILD_INFO, this.gatewayVersion)}
        </div>
      </afora-tooltip>
    `;
  }
}

if (globalThis.customElements && !customElements.get("afora-sidebar-build-chip")) {
  customElements.define("afora-sidebar-build-chip", SidebarBuildChip);
}
