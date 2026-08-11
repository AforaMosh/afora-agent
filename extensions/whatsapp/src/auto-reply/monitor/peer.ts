// Whatsapp plugin module implements peer behavior.
import { normalizeWhatsAppDirectIdentity } from "../../identity.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";

export function resolvePeerId(msg: AdmittedWebInboundMessage) {
  const admission = requireWhatsAppInboundAdmission(msg);
  if (admission.conversation.kind === "group") {
    return admission.conversation.id;
  }
  const ownerId = admission.sender.id;
  return normalizeWhatsAppDirectIdentity(ownerId) ?? ownerId;
}
