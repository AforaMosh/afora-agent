// Whatsapp plugin module implements peer behavior.
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { normalizeWhatsAppDirectIdentity } from "../../normalize-target.js";

export function resolvePeerId(msg: AdmittedWebInboundMessage) {
  const admission = requireWhatsAppInboundAdmission(msg);
  if (admission.conversation.kind === "group") {
    return admission.conversation.id;
  }
  const ownerId = admission.sender.id;
  return normalizeWhatsAppDirectIdentity(ownerId) ?? ownerId;
}
