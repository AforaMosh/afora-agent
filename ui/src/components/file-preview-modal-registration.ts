import { AforaFilePreviewModal } from "./file-preview-modal.ts";

if (!customElements.get("afora-file-preview-modal")) {
  customElements.define("afora-file-preview-modal", AforaFilePreviewModal);
}
