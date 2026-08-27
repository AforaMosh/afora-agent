import { AgentSelect } from "./agent-select.ts";

if (!customElements.get("afora-agent-select")) {
  customElements.define("afora-agent-select", AgentSelect);
}
