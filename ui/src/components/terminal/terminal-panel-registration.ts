import { AforaTerminalPanel } from "./terminal-panel.ts";

// Guarded define so shared registries can retain this module across reloads.
if (!customElements.get("afora-terminal-panel")) {
  customElements.define("afora-terminal-panel", AforaTerminalPanel);
}
