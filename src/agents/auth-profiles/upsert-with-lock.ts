/**
 * Locked auth profile upsert helper.
 * Normalizes literal secrets before persistence and routes all writes through
 * the shared SQLite lock to avoid racing concurrent auth updates.
 */
import { normalizeAuthProfileCredential } from "./credential-normalize.js";
import {
  resolvePersistedAuthProfileOwnerAgentDir,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
import { resetAuthProfileFailureState } from "./usage-state.js";

type AuthProfileUpsertParams = Parameters<typeof upsertAuthProfileWithLock>[0];

function throwAuthProfileUpdateError(): never {
  throw new Error(
    "Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.",
  );
}

async function upsertAuthProfileWithLockCore(
  params: AuthProfileUpsertParams,
  resetFailureState: boolean,
): Promise<AuthProfileStore | null> {
  const credential = normalizeAuthProfileCredential(params.credential);
  const agentDir = resetFailureState
    ? resolvePersistedAuthProfileOwnerAgentDir({
        agentDir: params.agentDir,
        profileId: params.profileId,
      })
    : params.agentDir;
  return await updateAuthProfileStoreWithLock({
    agentDir,
    stateDir: params.stateDir,
    saveOptions: {
      filterExternalAuthProfiles: false,
      ...(resetFailureState ? { preserveStateProfileIds: [params.profileId] } : {}),
      syncExternalCli: false,
    },
    updater: (store) => {
      store.profiles[params.profileId] = credential;
      if (resetFailureState) {
        store.usageStats = store.usageStats ?? {};
        const existingStats = store.usageStats[params.profileId];
        const credentialGeneration = (existingStats?.credentialGeneration ?? 0) + 1;
        if (!Number.isSafeInteger(credentialGeneration)) {
          throw new RangeError("Auth profile credential generation exhausted safe integer range");
        }
        store.usageStats[params.profileId] = resetAuthProfileFailureState(existingStats, {
          credentialGeneration,
        });
      }
      return true;
    },
  });
}

/** Upserts an auth profile under the store lock, returning null on store write failure. */
export async function upsertAuthProfileWithLock(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
  stateDir?: string;
}): Promise<AuthProfileStore | null> {
  return await upsertAuthProfileWithLockCore(params, false);
}

/** Upserts an auth profile under the store lock, failing when the store cannot be written. */
export async function upsertAuthProfileWithLockOrThrow(
  params: Parameters<typeof upsertAuthProfileWithLock>[0],
): Promise<void> {
  const updated = await upsertAuthProfileWithLock(params);
  if (!updated) {
    throwAuthProfileUpdateError();
  }
}

/** Atomically persists a completed login and clears failure state from the replaced credential. */
export async function upsertAuthProfileAfterLoginWithLock(
  params: AuthProfileUpsertParams,
): Promise<AuthProfileStore | null> {
  return await upsertAuthProfileWithLockCore(params, true);
}

/** Atomically persists a completed login and fails when the store cannot be written. */
export async function upsertAuthProfileAfterLoginWithLockOrThrow(
  params: AuthProfileUpsertParams,
): Promise<void> {
  const updated = await upsertAuthProfileAfterLoginWithLock(params);
  if (!updated) {
    throwAuthProfileUpdateError();
  }
}
