// Dreams tab host. Agent selection is owned by the parent Memory page.
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { AforaLightDomElement } from "../../lit/afora-element.ts";
import "../agents/memory/memory-panel.ts";

class MemoryDreamingSettings extends AforaLightDomElement {
  @property() agentId: string | null = null;

  override render() {
    return html`
      ${this.agentId
        ? html`<afora-agent-memory-panel .agentId=${this.agentId}></afora-agent-memory-panel>`
        : nothing}
    `;
  }
}

if (!customElements.get("afora-memory-dreaming")) {
  customElements.define("afora-memory-dreaming", MemoryDreamingSettings);
}
