// Whatsapp plugin module owns account credential-reset side effects.
import { clearWebCredentials } from "./auth-store.js";
import { clearWhatsAppDirectPeerOwners } from "./direct-peer-owner.js";

type ClearWebCredentialsParams = Parameters<typeof clearWebCredentials>[0];

export async function logoutWeb(
  params: ClearWebCredentialsParams & { accountId: string },
): Promise<boolean> {
  const { accountId, ...credentials } = params;
  const cleared = await clearWebCredentials(credentials);
  if (!cleared) {
    return false;
  }
  // Peer ownership belongs to the credential generation, not the durable account id.
  // Clear only after credential deletion succeeds so skipped logout preserves live state.
  await clearWhatsAppDirectPeerOwners(accountId);
  return true;
}
