import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@afora/normalization-core/record-coerce";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  createSqliteLifecycleAggregateError,
  runWithSqliteCoordinator,
} from "../infra/sqlite-coordinator.js";
import { quarantineOrphanedSqliteSidecars } from "../infra/sqlite-files.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "../infra/sqlite-readonly-location.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import { AFORA_SQLITE_BUSY_TIMEOUT_MS } from "./afora-state-db-contract.js";
import { tableExists } from "./afora-state-db-schema-helpers.js";

export const STATE_SUPERVISION_KEY = "gateway.supervision";
const MAX_OWNERSHIP_TIMESTAMP_MS = 8_640_000_000_000_000;
const MANAGER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type AforaExternalStateOwnership = {
  claimedAt: number;
  managerId: string;
  mode: "external";
  version: 1;
};

export class AforaStateOwnershipError extends Error {}

export class AforaStateOwnershipMetadataError extends AforaStateOwnershipError {
  constructor(
    readonly databasePath: string,
    message: string,
  ) {
    super(
      `Afora shared state ownership metadata is invalid at ${databasePath}: ${message}. ` +
        "Repair it with AFORA_SUPERVISOR_MODE=external afora database ownership claim --manager <manager-id>.",
    );
    this.name = "AforaStateOwnershipMetadataError";
  }
}

class AforaStateExternalOwnershipError extends AforaStateOwnershipError {
  constructor(
    readonly databasePath: string,
    readonly managerId: string,
  ) {
    super(
      `Afora shared state database ${databasePath} is externally supervised by ${managerId}. ` +
        "Use that external supervisor with AFORA_SUPERVISOR_MODE=external for writable operations.",
    );
    this.name = "AforaStateExternalOwnershipError";
  }
}

export function normalizeAforaStateManagerId(managerId: string): string {
  const normalized = managerId.trim();
  if (!MANAGER_ID_PATTERN.test(normalized)) {
    throw new Error(
      "External state ownership manager id must be a 1-128 character ASCII identifier.",
    );
  }
  return normalized;
}

function parseExternalOwnership(
  valueJson: string,
  databasePath: string,
): AforaExternalStateOwnership {
  let value: unknown;
  try {
    value = JSON.parse(valueJson) as unknown;
  } catch {
    throw new AforaStateOwnershipMetadataError(databasePath, "reserved value is not valid JSON");
  }
  const record = isRecord(value) ? value : undefined;
  const keys = record ? Object.keys(record).toSorted().join(",") : "";
  const managerId = record?.managerId;
  const claimedAt = record?.claimedAt;
  if (
    keys !== "claimedAt,managerId,mode,version" ||
    record?.version !== 1 ||
    record?.mode !== "external" ||
    typeof managerId !== "string" ||
    !MANAGER_ID_PATTERN.test(managerId) ||
    typeof claimedAt !== "number" ||
    !Number.isSafeInteger(claimedAt) ||
    claimedAt < 0 ||
    claimedAt > MAX_OWNERSHIP_TIMESTAMP_MS
  ) {
    throw new AforaStateOwnershipMetadataError(
      databasePath,
      "reserved value does not match the version 1 external ownership contract",
    );
  }
  return {
    version: 1,
    mode: "external",
    managerId,
    claimedAt,
  };
}

/** Inspect the reserved ownership row without entering the shared-state lifecycle. */
export function inspectAforaStateOwnershipFromDatabase(
  database: DatabaseSync,
  databasePath: string,
): AforaExternalStateOwnership | null {
  if (!tableExists(database, "config_machine_state")) {
    return null;
  }
  const row = database
    .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ? LIMIT 1")
    .get(STATE_SUPERVISION_KEY) as { value_json?: unknown } | undefined;
  if (!row) {
    return null;
  }
  if (typeof row.value_json !== "string") {
    throw new AforaStateOwnershipMetadataError(databasePath, "reserved value is not text");
  }
  return parseExternalOwnership(row.value_json, databasePath);
}

function inspectOwnershipThroughConnection(
  location: string,
  databasePath: string,
): AforaExternalStateOwnership | null {
  const database = openNodeSqliteDatabase(location, { readOnly: true });
  try {
    database.exec(
      `PRAGMA busy_timeout = ${AFORA_SQLITE_BUSY_TIMEOUT_MS}; PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;`,
    );
    return inspectAforaStateOwnershipFromDatabase(database, databasePath);
  } finally {
    database.close();
  }
}

function inspectJournalAwarePublicOwnership(
  databasePath: string,
): AforaExternalStateOwnership | null {
  const prepared = prepareSqliteReadOnlyLocationSync(databasePath);
  try {
    return inspectOwnershipThroughConnection(prepared.location, databasePath);
  } finally {
    prepared.cleanup();
  }
}

function inspectAforaStateOwnershipAtPathWhileCoordinatorHeld(
  databasePath: string,
): AforaExternalStateOwnership | null {
  const resolvedPath = path.resolve(databasePath);
  if (!existsSync(resolvedPath)) {
    return null;
  }
  // Write admission owns locking and recovery while the coordinator is held.
  // Inspect the live committed view without cloning a potentially busy family.
  const database = openNodeSqliteDatabase(resolvedPath);
  try {
    database.exec(
      `PRAGMA busy_timeout = ${AFORA_SQLITE_BUSY_TIMEOUT_MS}; PRAGMA trusted_schema = OFF;`,
    );
    return inspectAforaStateOwnershipFromDatabase(database, resolvedPath);
  } finally {
    database.close();
  }
}

function acquireAforaStateOwnershipCoordinator(databasePath: string): {
  release: () => void;
} {
  return acquireStateDatabaseCoordinator({
    databasePath,
    busyTimeoutMs: AFORA_SQLITE_BUSY_TIMEOUT_MS,
  });
}

export function runWithAforaStateOwnershipCoordinator<T>(
  databasePath: string,
  operationLabel: string,
  operation: () => T,
): T {
  return runWithSqliteCoordinator(
    acquireAforaStateOwnershipCoordinator(databasePath),
    operationLabel,
    operation,
  );
}

/** Inspect one resolved state database path without mutating its state tree. */
export function inspectAforaStateOwnershipAtPath(
  databasePath: string,
): AforaExternalStateOwnership | null {
  const resolvedPath = path.resolve(databasePath);
  if (!existsSync(resolvedPath)) {
    return null;
  }
  return inspectJournalAwarePublicOwnership(resolvedPath);
}

function assertOwnershipAllowsWrite(
  status: AforaExternalStateOwnership | null,
  databasePath: string,
  env: NodeJS.ProcessEnv,
): void {
  if (status && !isGatewayExternallySupervised(env)) {
    throw new AforaStateExternalOwnershipError(databasePath, status.managerId);
  }
}

/** Fence and hold one path-based mutation until its main-file preamble is complete. */
function acquireAforaStateWriteAccess(options: {
  databasePath: string;
  env?: NodeJS.ProcessEnv;
}): { release: () => void } {
  const resolvedPath = path.resolve(options.databasePath);
  const access = acquireAforaStateOwnershipCoordinator(resolvedPath);
  try {
    quarantineOrphanedSqliteSidecars(resolvedPath);
    assertOwnershipAllowsWrite(
      inspectAforaStateOwnershipAtPathWhileCoordinatorHeld(resolvedPath),
      resolvedPath,
      options.env ?? process.env,
    );
    return access;
  } catch (operationError) {
    let releaseFailed = false;
    let releaseError: unknown;
    try {
      access.release();
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }
    if (releaseFailed) {
      throw createSqliteLifecycleAggregateError(
        [operationError, releaseError],
        "state ownership inspection and coordinator release both failed",
        operationError,
      );
    }
    throw operationError;
  }
}

export function runWithAforaStateWriteAccess<T>(
  options: { databasePath: string; env?: NodeJS.ProcessEnv },
  operationLabel: string,
  operation: () => T,
): T {
  return runWithSqliteCoordinator(
    acquireAforaStateWriteAccess(options),
    operationLabel,
    operation,
  );
}

/** Check write admission; callers may defer orphan-sidecar recovery until mutation is certain. */
export async function assertAforaStateWriteAllowedAtPath(options: {
  databasePath: string;
  env?: NodeJS.ProcessEnv;
  recoverOrphanedSidecars?: boolean;
}): Promise<void> {
  const databasePath = path.resolve(options.databasePath);
  const recoverOrphanedSidecars = options.recoverOrphanedSidecars !== false;
  if (recoverOrphanedSidecars) {
    quarantineOrphanedSqliteSidecars(databasePath);
  }
  if (!existsSync(databasePath)) {
    return;
  }
  const env = options.env ?? process.env;
  if (recoverOrphanedSidecars && isGatewayExternallySupervised(env)) {
    runWithAforaStateWriteAccess(
      { ...options, databasePath },
      "shared state write admission",
      () => undefined,
    );
    return;
  }
  const prepared = await prepareSqliteReadOnlyLocation(databasePath);
  try {
    assertOwnershipAllowsWrite(
      inspectOwnershipThroughConnection(prepared.location, databasePath),
      databasePath,
      env,
    );
  } finally {
    prepared.cleanup();
  }
}

/** Fence shared-state writes once an external manager has claimed ownership. */
export function assertAforaStateWriteAllowed(options: {
  database: DatabaseSync;
  databasePath: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const resolvedPath = path.resolve(options.databasePath);
  const status = inspectAforaStateOwnershipFromDatabase(options.database, resolvedPath);
  assertOwnershipAllowsWrite(status, resolvedPath, options.env ?? process.env);
}
