import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  initializeCachedClawInstallSchemaVersions,
  readCachedClawInstallSchemaVersions,
} from "../claws/provenance-runtime-read.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import { tryAcquireExclusiveSqliteCoordinator } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateDirForDatabasePath } from "../state/openclaw-state-db.paths.js";
import { listAuditEvents } from "./audit-event-store.js";
import type { AuditEventInput } from "./audit-event-types.js";
import { createAuditEventWriter } from "./audit-event-writer.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function input(): AuditEventInput {
  return {
    sourceId: "cold-owner-coordinator",
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: "cold-owner-coordinator",
  };
}

function resolveOwnershipCoordinatorPath(databasePath: string): string {
  const canonicalDatabasePath = resolvePathViaExistingAncestorSync(databasePath);
  const stateDir = resolveOpenClawStateDirForDatabasePath(canonicalDatabasePath);
  return path.join(
    resolveGatewayLockDir(stateDir),
    `state-ownership.${sha256HexPrefixCore(canonicalDatabasePath, 8)}.lock.sqlite`,
  );
}

describe("audit event writer cold ownership", () => {
  it("retries a held coordinator without blocking or poisoning provenance", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = openOpenClawStateDatabase(database).path;
    closeOpenClawStateDatabaseForTest();
    initializeCachedClawInstallSchemaVersions(database);
    expect(readCachedClawInstallSchemaVersions(database)).toMatchObject({ kind: "ready" });
    const coordinator = tryAcquireExclusiveSqliteCoordinator(
      resolveOwnershipCoordinatorPath(databasePath),
      { busyTimeoutMs: 0 },
    );
    if (!coordinator) {
      throw new Error("expected to acquire the state ownership coordinator");
    }
    const errors: string[] = [];
    const startedAt = performance.now();
    const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });

    try {
      await writer.ready;
      expect(performance.now() - startedAt).toBeLessThan(250);
      expect(readCachedClawInstallSchemaVersions(database)).toMatchObject({ kind: "ready" });
      expect(writer.record(input())).toBe(true);
    } finally {
      coordinator.release();
      await writer.stop();
    }

    expect(errors).toEqual([]);
    expect(listAuditEvents({ database, limit: 10 }).events.map((event) => event.runId)).toContain(
      "cold-owner-coordinator",
    );
  });
});
