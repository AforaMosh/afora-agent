// Opaque capability exchanged between the pairing owner and memory identity persistence.
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { PairingChannel } from "./pairing-store.types.js";

const channelPairingMemoryIdentityApprovalBrand: unique symbol = Symbol(
  "openclaw.channel-pairing-memory-identity-approval",
);
const approvals = new WeakMap<object, ChannelPairingMemoryIdentityApprovalRecord>();

export type ConsumedChannelPairingMemoryIdentityApproval = Readonly<{
  [channelPairingMemoryIdentityApprovalBrand]: true;
}>;

type ChannelPairingMemoryIdentityApprovalRecord = Readonly<{
  database: OpenClawStateDatabase;
  channel: PairingChannel;
  accountId: string;
  requestId: string;
  stableSenderId: string;
}>;

export type ConsumedChannelPairingMemoryIdentityFacts = Omit<
  ChannelPairingMemoryIdentityApprovalRecord,
  "database"
>;

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

/**
 * Pairing-store-only mint: the request has already been selected for removal
 * in this exact transaction, so shaped caller data cannot recreate this proof.
 */
export function mintConsumedChannelPairingMemoryIdentityApproval(params: {
  database: OpenClawStateDatabase;
  channel: PairingChannel;
  accountId: string;
  requestId: string;
  stableSenderId: string;
}): ConsumedChannelPairingMemoryIdentityApproval {
  const approval = Object.create(null) as Omit<
    ConsumedChannelPairingMemoryIdentityApproval,
    typeof channelPairingMemoryIdentityApprovalBrand
  > & {
    [channelPairingMemoryIdentityApprovalBrand]?: true;
  };
  Object.defineProperty(approval, channelPairingMemoryIdentityApprovalBrand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  approvals.set(
    approval,
    Object.freeze({
      database: params.database,
      channel: requireText(params.channel, "channel") as PairingChannel,
      accountId: requireText(params.accountId, "accountId"),
      requestId: requireText(params.requestId, "requestId"),
      stableSenderId: requireText(params.stableSenderId, "stableSenderId"),
    }),
  );
  return Object.freeze(approval) as ConsumedChannelPairingMemoryIdentityApproval;
}

/** Consumes one proof only inside the transaction that removed its pending request. */
export function consumeChannelPairingMemoryIdentityApproval(params: {
  approval: unknown;
  database: OpenClawStateDatabase;
}): ConsumedChannelPairingMemoryIdentityFacts | undefined {
  if (
    !params.approval ||
    typeof params.approval !== "object" ||
    !params.database.db.isTransaction
  ) {
    return undefined;
  }
  const record = approvals.get(params.approval);
  if (!record || record.database !== params.database) {
    return undefined;
  }
  approvals.delete(params.approval);
  return {
    channel: record.channel,
    accountId: record.accountId,
    requestId: record.requestId,
    stableSenderId: record.stableSenderId,
  };
}
