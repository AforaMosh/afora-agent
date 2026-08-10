import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  claimNativeHookRelayBridgeRecord,
  deleteNativeHookRelayBridgeRecordIfOwned,
  pruneNativeHookRelayBridgeRecords,
  readNativeHookRelayBridgeRecord,
  type NativeHookRelayBridgeRecord,
} from "./native-hook-relay-store.js";

let testRoot = "";
let primaryStateDbPath = "";
let secondaryStateDbPath = "";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  testRoot = tempDirs.make("openclaw-native-hook-relay-store-");
  primaryStateDbPath = path.join(testRoot, "primary.sqlite");
  secondaryStateDbPath = path.join(testRoot, "secondary.sqlite");
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function bridgeRecord(
  relayId: string,
  overrides: Partial<NativeHookRelayBridgeRecord> = {},
): NativeHookRelayBridgeRecord {
  return {
    relayId,
    pid: 100,
    hostname: "127.0.0.1",
    port: 18_789,
    token: "test-token-placeholder",
    expiresAtMs: 20_000,
    ...overrides,
  };
}

function seedBridgeRecord(params: {
  record: NativeHookRelayBridgeRecord;
  stateDbPath: string;
  updatedAtMs?: number;
}): void {
  const { record } = params;
  const updatedAtMs = params.updatedAtMs ?? Date.now();
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<
        Pick<OpenClawStateKyselyDatabase, "native_hook_relay_bridges">
      >(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("native_hook_relay_bridges")
          .values({
            relay_id: record.relayId,
            pid: record.pid,
            hostname: record.hostname,
            port: record.port,
            token: record.token,
            expires_at_ms: record.expiresAtMs,
            updated_at_ms: updatedAtMs,
          })
          .onConflict((conflict) =>
            conflict.column("relay_id").doUpdateSet({
              pid: record.pid,
              hostname: record.hostname,
              port: record.port,
              token: record.token,
              expires_at_ms: record.expiresAtMs,
              updated_at_ms: updatedAtMs,
            }),
          ),
      );
    },
    { path: params.stateDbPath },
  );
}

describe("native hook relay store", () => {
  it("claims a missing bridge record", () => {
    const record = bridgeRecord("relay-claim-missing");

    expect(
      claimNativeHookRelayBridgeRecord({
        record,
        updatedAtMs: 1_000,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe("renewed");
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: record.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(record);
  });

  it("keeps a pending claim authoritative without exposing it as a locator", () => {
    const pending = bridgeRecord("relay-claim-pending", { port: 0 });
    expect(
      claimNativeHookRelayBridgeRecord({
        record: pending,
        updatedAtMs: 1_000,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe("renewed");
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: pending.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBeUndefined();
    expect(
      claimNativeHookRelayBridgeRecord({
        record: { ...pending, pid: pending.pid + 1, port: 18_790, token: "foreign-token" },
        updatedAtMs: 2_000,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe("foreign-owner");
  });

  it("claims a live bridge through its exact same-process predecessor", () => {
    const predecessor = bridgeRecord("relay-claim-predecessor", {
      pid: process.pid,
      token: "predecessor-token",
    });
    const replacement = { ...predecessor, port: predecessor.port + 1, token: "replacement-token" };
    seedBridgeRecord({
      record: predecessor,
      updatedAtMs: 1_000,
      stateDbPath: primaryStateDbPath,
    });

    expect(
      claimNativeHookRelayBridgeRecord({
        record: replacement,
        predecessor,
        updatedAtMs: 2_000,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe("renewed");
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: replacement.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(replacement);
  });

  it("preserves a live foreign claim through the expiry instant and reclaims it afterward", () => {
    const foreign = bridgeRecord("relay-claim-foreign", { expiresAtMs: 5_000 });
    const claimant = { ...foreign, pid: foreign.pid + 1, token: "claimant-token" };
    seedBridgeRecord({
      record: foreign,
      updatedAtMs: 1_000,
      stateDbPath: primaryStateDbPath,
    });

    for (const predecessor of [undefined, { pid: foreign.pid, token: "wrong-token" }]) {
      expect(
        claimNativeHookRelayBridgeRecord({
          record: claimant,
          predecessor,
          updatedAtMs: foreign.expiresAtMs,
          stateDbPath: primaryStateDbPath,
        }),
      ).toBe("foreign-owner");
    }
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: foreign.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(foreign);
    expect(
      claimNativeHookRelayBridgeRecord({
        record: claimant,
        updatedAtMs: foreign.expiresAtMs + 1,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe("renewed");
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: claimant.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(claimant);
  });

  it("reads bridge records from the state database", () => {
    const first = bridgeRecord("relay-upsert");
    const replacement = bridgeRecord("relay-upsert", {
      pid: 101,
      port: 18_790,
      token: "test-auth-token",
      expiresAtMs: 30_000,
    });

    seedBridgeRecord({
      record: first,
      updatedAtMs: 1_000,
      stateDbPath: primaryStateDbPath,
    });
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: first.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(first);

    seedBridgeRecord({
      record: replacement,
      updatedAtMs: 2_000,
      stateDbPath: primaryStateDbPath,
    });
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: replacement.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(replacement);
  });

  it("requires matching token and pid to renew or delete a bridge", () => {
    const record = bridgeRecord("relay-owned");
    seedBridgeRecord({
      record,
      updatedAtMs: 1_000,
      stateDbPath: primaryStateDbPath,
    });

    expect(
      claimNativeHookRelayBridgeRecord({
        record: { ...record, pid: record.pid + 1, expiresAtMs: 30_000 },
        updatedAtMs: 1_500,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe("foreign-owner");
    expect(
      claimNativeHookRelayBridgeRecord({
        record: { ...record, token: "decoy-token", expiresAtMs: 30_000 },
        updatedAtMs: 1_500,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe("foreign-owner");
    expect(
      claimNativeHookRelayBridgeRecord({
        record: { ...record, expiresAtMs: 30_000 },
        updatedAtMs: 2_000,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe("renewed");
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: record.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual({ ...record, expiresAtMs: 30_000 });

    expect(
      deleteNativeHookRelayBridgeRecordIfOwned({
        ...record,
        pid: record.pid + 1,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(false);
    expect(
      deleteNativeHookRelayBridgeRecordIfOwned({
        ...record,
        token: "decoy-token",
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(false);
    expect(
      deleteNativeHookRelayBridgeRecordIfOwned({
        ...record,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(true);
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: record.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBeUndefined();
  });

  it("atomically reclaims an expired foreign record", () => {
    const record = bridgeRecord("relay-expired-foreign", { expiresAtMs: 5_000 });
    seedBridgeRecord({
      record,
      updatedAtMs: 1_000,
      stateDbPath: primaryStateDbPath,
    });

    const replacement = {
      ...record,
      pid: record.pid + 1,
      token: "test-auth-token",
      expiresAtMs: 30_000,
    };
    expect(
      claimNativeHookRelayBridgeRecord({
        record: replacement,
        updatedAtMs: 6_000,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe("renewed");
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: record.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(replacement);
  });

  it("restores a missing record without overwriting another owner", () => {
    const record = bridgeRecord("relay-restored");
    expect(
      claimNativeHookRelayBridgeRecord({
        record,
        updatedAtMs: 1_000,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe("renewed");
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: record.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(record);

    const otherOwner = bridgeRecord(record.relayId, {
      pid: record.pid + 1,
      token: "test-auth-token",
    });
    seedBridgeRecord({
      record: otherOwner,
      updatedAtMs: 2_000,
      stateDbPath: primaryStateDbPath,
    });
    expect(
      claimNativeHookRelayBridgeRecord({
        record,
        updatedAtMs: 3_000,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe("foreign-owner");
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: record.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(otherOwner);
  });

  it("does not let an old owner delete its replacement", () => {
    const oldOwner = bridgeRecord("relay-replaced", {
      pid: 100,
      token: "secret-token",
    });
    const replacement = bridgeRecord("relay-replaced", {
      pid: 101,
      port: 18_790,
      token: "test-auth-token",
      expiresAtMs: 30_000,
    });
    seedBridgeRecord({
      record: oldOwner,
      updatedAtMs: 1_000,
      stateDbPath: primaryStateDbPath,
    });
    seedBridgeRecord({
      record: replacement,
      updatedAtMs: 2_000,
      stateDbPath: primaryStateDbPath,
    });

    expect(
      deleteNativeHookRelayBridgeRecordIfOwned({
        ...oldOwner,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBe(false);
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: replacement.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(replacement);
  });

  it("prunes expired and dead bridges while preserving live and unknown pids", () => {
    const expired = bridgeRecord("relay-expired", { pid: 200, expiresAtMs: 9_999 });
    const dead = bridgeRecord("relay-dead", { pid: 201 });
    const live = bridgeRecord("relay-live", { pid: 202 });
    const unknown = bridgeRecord("relay-unknown", { pid: 203 });
    for (const [index, record] of [expired, dead, live, unknown].entries()) {
      seedBridgeRecord({
        record,
        updatedAtMs: 1_000 + index,
        stateDbPath: primaryStateDbPath,
      });
    }
    const isPidDead = vi.fn((pid: number) => pid === dead.pid);

    const pruned = pruneNativeHookRelayBridgeRecords({
      currentPid: 100,
      isPidDead,
      nowMs: 10_000,
      stateDbPath: primaryStateDbPath,
    });

    expect(pruned).toHaveLength(2);
    expect(pruned).toEqual(
      expect.arrayContaining([
        { relayId: expired.relayId, pid: expired.pid, reason: "expired" },
        { relayId: dead.relayId, pid: dead.pid, reason: "dead-pid" },
      ]),
    );
    expect(new Set(isPidDead.mock.calls.map(([pid]) => pid))).toStrictEqual(
      new Set([dead.pid, live.pid, unknown.pid]),
    );
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: expired.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBeUndefined();
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: dead.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toBeUndefined();
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: live.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(live);
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: unknown.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(unknown);
  });

  it("preserves a replacement published during dead-pid planning", () => {
    const stale = bridgeRecord("relay-prune-race", {
      pid: 201,
      token: "secret-token",
    });
    const replacement = bridgeRecord("relay-prune-race", {
      pid: 202,
      port: 18_790,
      token: "test-auth-token",
      expiresAtMs: 30_000,
    });
    seedBridgeRecord({
      record: stale,
      updatedAtMs: 1_000,
      stateDbPath: primaryStateDbPath,
    });

    const pruned = pruneNativeHookRelayBridgeRecords({
      currentPid: 100,
      isPidDead: (pid) => {
        expect(pid).toBe(stale.pid);
        seedBridgeRecord({
          record: replacement,
          updatedAtMs: 2_000,
          stateDbPath: primaryStateDbPath,
        });
        return true;
      },
      nowMs: 10_000,
      stateDbPath: primaryStateDbPath,
    });

    expect(pruned).toStrictEqual([]);
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: replacement.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(replacement);
  });

  it("isolates records by the exact state database path", () => {
    const primary = bridgeRecord("relay-isolated", {
      pid: 100,
      token: "config-token",
    });
    const secondary = bridgeRecord("relay-isolated", {
      pid: 200,
      port: 18_790,
      token: "gateway-token",
    });
    seedBridgeRecord({
      record: primary,
      stateDbPath: primaryStateDbPath,
    });
    seedBridgeRecord({
      record: secondary,
      stateDbPath: secondaryStateDbPath,
    });

    expect(fs.existsSync(primaryStateDbPath)).toBe(true);
    expect(fs.existsSync(secondaryStateDbPath)).toBe(true);
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: primary.relayId,
        stateDbPath: primaryStateDbPath,
      }),
    ).toStrictEqual(primary);
    expect(
      readNativeHookRelayBridgeRecord({
        relayId: secondary.relayId,
        stateDbPath: secondaryStateDbPath,
      }),
    ).toStrictEqual(secondary);
  });
});
