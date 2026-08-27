// Public custom-element entrypoint for the Control UI chat pane.
import { ChatPane } from "./chat-pane-render.ts";

if (!customElements.get("afora-chat-pane")) {
  customElements.define("afora-chat-pane", ChatPane);
}

declare global {
  interface HTMLElementTagNameMap {
    "afora-chat-pane": ChatPane;
  }
}
