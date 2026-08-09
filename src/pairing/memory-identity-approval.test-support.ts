// Test-only helpers that exercise the same consumed-pairing proof as production.
import type { MemoryIdentityBinding } from "../state/memory-identity.js";
import { memoryIdentityLifecycle } from "../state/memory-identity.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  approveChannelPairingRequest,
  listChannelPairingRequests,
  resolveChannelPairingRequestId,
  upsertChannelPairingRequest,
} from "./pairing-store.js";
import type { PairingChannel } from "./pairing-store.types.js";

/** Creates test bindings only by consuming a real pending channel-pairing request. */
export async function createMemoryIdentityBindingThroughApprovedPairing(params: {
  accountId: string;
  channel: PairingChannel;
  now?: number;
  options: OpenClawStateDatabaseOptions;
  principalId: string;
  stableSenderId: string;
}): Promise<MemoryIdentityBinding> {
  const env = params.options.env ?? process.env;
  const creator = ensureProfileForEmail("memory-pairing-test-owner@example.test", params.options);
  await upsertChannelPairingRequest({
    channel: params.channel,
    accountId: params.accountId,
    id: params.stableSenderId,
    env,
  });
  const request = (await listChannelPairingRequests(params.channel, env, params.accountId)).find(
    (candidate) => candidate.id === params.stableSenderId,
  );
  if (!request) {
    throw new Error("test pairing request was not persisted");
  }
  let binding: MemoryIdentityBinding | undefined;
  const approved = await approveChannelPairingRequest({
    channel: params.channel,
    accountId: params.accountId,
    requestId: resolveChannelPairingRequestId(params.channel, request),
    env,
    pairingAdapter: { idLabel: "Test sender" },
    onApproved: ({ database, approval }) => {
      binding = memoryIdentityLifecycle.createMemoryIdentityBindingFromApprovedChannelPairing({
        database,
        approval,
        principalId: params.principalId,
        creatorProfileId: creator.id,
        now: params.now,
      });
    },
  });
  if (!approved || !binding) {
    throw new Error("test pairing approval did not create a memory identity binding");
  }
  return binding;
}
