import { resolveAuthProfileDatabasePath } from "./sqlite.js";

const MAX_PUBLICATION_OWNERS = 256;
let publicationRevision = 0;
const ownerGenerations = new Map<string, number>();

export type RuntimeAuthProfileStorePublicationToken = {
  ownerKey: string;
  ownerGeneration: number;
  mainGeneration: number;
};

/**
 * Captures durable commit order without reopening SQLite during publication.
 * Derived publishers also fence against newer main-store commits they inherit.
 */
export function captureRuntimeAuthProfileStorePublicationToken(
  agentDir?: string,
  options?: { advanceOwner?: boolean; inheritedMainGeneration?: number },
): RuntimeAuthProfileStorePublicationToken {
  const ownerKey = resolveAuthProfileDatabasePath(agentDir);
  const mainKey = resolveAuthProfileDatabasePath();
  if (options?.advanceOwner === true) {
    publicationRevision += 1;
    ownerGenerations.delete(ownerKey);
    ownerGenerations.set(ownerKey, publicationRevision);
    while (ownerGenerations.size > MAX_PUBLICATION_OWNERS) {
      const oldestOwnerKey = ownerGenerations.keys().next().value;
      if (oldestOwnerKey === undefined) {
        break;
      }
      ownerGenerations.delete(oldestOwnerKey);
    }
  }
  return {
    ownerKey,
    ownerGeneration: ownerGenerations.get(ownerKey) ?? 0,
    mainGeneration:
      ownerKey === mainKey
        ? (ownerGenerations.get(mainKey) ?? 0)
        : (options?.inheritedMainGeneration ?? ownerGenerations.get(mainKey) ?? 0),
  };
}

export function getRuntimeAuthProfileStorePublicationGeneration(agentDir?: string): number {
  return ownerGenerations.get(resolveAuthProfileDatabasePath(agentDir)) ?? 0;
}

export function isRuntimeAuthProfileStorePublicationTokenCurrent(
  token: RuntimeAuthProfileStorePublicationToken,
): boolean {
  return (
    isRuntimeAuthProfileStorePublicationOwnerCurrent(token) &&
    isRuntimeAuthProfileStorePublicationMainCurrent(token)
  );
}

export function isRuntimeAuthProfileStorePublicationOwnerCurrent(
  token: RuntimeAuthProfileStorePublicationToken,
): boolean {
  return token.ownerGeneration === (ownerGenerations.get(token.ownerKey) ?? 0);
}

export function isRuntimeAuthProfileStorePublicationMainCurrent(
  token: RuntimeAuthProfileStorePublicationToken,
): boolean {
  return token.mainGeneration === (ownerGenerations.get(resolveAuthProfileDatabasePath()) ?? 0);
}
