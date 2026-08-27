import { ApprovalPage } from "./approval-page.ts";

if (!customElements.get("afora-approval-page")) {
  customElements.define("afora-approval-page", ApprovalPage);
}
