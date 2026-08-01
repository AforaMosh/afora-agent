import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { listAuditEvents } from "./audit-event-store.js";
import type { AuditEventInput } from "./audit-event-types.js";
import { createAuditEventWriter } from "./audit-event-writer.js";
import {
  configureExecutionIdentityAdmissionSink,
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionEnvelope,
  type ExecutionIdentityAdmissionFacts,
} from "./execution-identity-admission.js";
import {
  inspectExecutionIdentityRun,
  persistExecutionIdentityAdmissionEnvelope,
} from "./execution-identity-context.js";

function captureExecutionIdentityAdmissionEnvelope(
  facts: ExecutionIdentityAdmissionFacts,
  options: { contextId?: string; now?: number; runtimeInstanceId?: string } = {},
) {
  let captured: ExecutionIdentityAdmissionEnvelope | undefined;
  const clear = configureExecutionIdentityAdmissionSink((envelope) => {
    captured = envelope;
    return true;
  });
  const result = enqueueExecutionIdentityContextAtAdmission(facts, {
    ...options,
    enabled: true,
  });
  clear();
  if (!result || !captured) {
    throw new Error("expected admission envelope");
  }
  return captured;
}

function input(): AuditEventInput {
  return {
    sourceId: "run-1:1:started",
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: "run-1",
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("audit event worker", () => {
  it("returns immediately under SQLite contention and flushes before stop", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const errors: string[] = [];
    const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });
    await writer.ready;
    const { db } = openOpenClawStateDatabase(database);
    db.exec("BEGIN IMMEDIATE");
    const startedAt = performance.now();
    expect(writer.record(input())).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(250);
    db.exec("ROLLBACK");

    await writer.stop();
    expect(errors).toEqual([]);
    expect(listAuditEvents({ database, limit: 10 }).events).toHaveLength(1);
  });

  it("keeps first-use identity admission prompt under a held write lock", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { db } = openOpenClawStateDatabase(database);
    db.exec("DROP TABLE execution_identity_contexts; DELETE FROM audit_identity_keys;");
    db.exec("BEGIN IMMEDIATE");
    const errors: string[] = [];
    const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });
    const clearSink = configureExecutionIdentityAdmissionSink(writer.recordExecutionIdentity);
    const admittedAt = Date.now();

    const startedAt = performance.now();
    expect(
      enqueueExecutionIdentityContextAtAdmission(
        {
          runId: "held-lock-run",
          agentId: "main",
          ingress: {
            kind: "local-cli",
            boundary: "agent-command.local",
            state: "present",
            rawSourceRef: "raw-ingress-secret",
          },
          runtime: { kind: "embedded" },
          invoker: { kind: "local-account", rawPrincipalRef: "raw-principal-secret" },
        },
        {
          enabled: true,
          contextId: "held-lock-context",
          now: admittedAt,
          runtimeInstanceId: "raw-runtime-secret",
        },
      ),
    ).toEqual({ contextId: "held-lock-context", accepted: true });
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'execution_identity_contexts'").get(),
    ).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_identity_keys").get()).toEqual({
      count: 0,
    });

    db.exec("ROLLBACK");
    clearSink();
    await writer.stop();
    expect(errors).toEqual([]);
    expect(
      inspectExecutionIdentityRun({ runId: "held-lock-run" }, { ...database, now: admittedAt }),
    ).toMatchObject({
      identity: {
        state: "present",
        context: {
          contextId: "held-lock-context",
          runId: "held-lock-run",
          createdAt: admittedAt,
          ingress: {
            kind: "local-cli",
            boundary: "agent-command.local",
            state: "present",
          },
          runtimeInstance: { kind: "embedded", state: "present" },
        },
      },
    });
    const persisted = db
      .prepare("SELECT context_json FROM execution_identity_contexts WHERE run_id = ?")
      .get("held-lock-run") as { context_json: string };
    for (const raw of ["raw-ingress-secret", "raw-principal-secret", "raw-runtime-secret"]) {
      expect(persisted.context_json).not.toContain(raw);
      expect(JSON.stringify(errors)).not.toContain(raw);
    }
  });

  it("prunes expired identity contexts at startup without a new run", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    persistExecutionIdentityAdmissionEnvelope(
      captureExecutionIdentityAdmissionEnvelope(
        {
          runId: "expired-before-startup",
          agentId: "main",
          ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
          runtime: { kind: "embedded" },
        },
        { now: 0, runtimeInstanceId: "runtime-1" },
      ),
      { ...database, now: 0 },
    );
    closeOpenClawStateDatabaseForTest();

    const errors: string[] = [];
    const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });
    await writer.ready;

    expect(
      openOpenClawStateDatabase(database)
        .db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts")
        .get(),
    ).toEqual({ count: 0 });
    await writer.stop();
    expect(errors).toEqual([]);
  });

  it("uses one pending limit across audit events and identity envelopes", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { db } = openOpenClawStateDatabase(database);
    db.exec("BEGIN IMMEDIATE");
    const errors: string[] = [];
    const writer = createAuditEventWriter({
      stateDir,
      maxPending: 1,
      onError: (error) => errors.push(error),
    });
    expect(writer.record(input())).toBe(true);
    expect(
      writer.recordExecutionIdentity(
        captureExecutionIdentityAdmissionEnvelope(
          {
            runId: "queue-full-run",
            agentId: "main",
            ingress: { kind: "local-cli", boundary: "agent-command.local" },
            runtime: { kind: "embedded" },
          },
          { runtimeInstanceId: "runtime-1" },
        ),
      ),
    ).toBe(false);
    expect(errors).toContain("audit event queue is full (1); dropping metadata");
    db.exec("ROLLBACK");
    await writer.stop();
    expect(listAuditEvents({ database, limit: 10 }).events).toHaveLength(1);
  });

  it("preserves FIFO idempotency and rejects a later conflicting run envelope", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const errors: string[] = [];
    const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });
    const admittedAt = Date.now();
    const original = captureExecutionIdentityAdmissionEnvelope(
      {
        runId: "ordered-run",
        agentId: "main",
        ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
        runtime: { kind: "embedded" },
      },
      { contextId: "ordered-context", now: admittedAt, runtimeInstanceId: "runtime-1" },
    );
    const conflict = captureExecutionIdentityAdmissionEnvelope(
      {
        runId: "ordered-run",
        agentId: "other",
        ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
        runtime: { kind: "embedded" },
      },
      { contextId: "ignored-context", now: admittedAt + 1, runtimeInstanceId: "runtime-1" },
    );

    expect(writer.recordExecutionIdentity(original)).toBe(true);
    expect(writer.recordExecutionIdentity(original)).toBe(true);
    expect(writer.recordExecutionIdentity(conflict)).toBe(true);
    await writer.stop();

    expect(errors).toEqual(["audit execution identity context conflict"]);
    expect(
      inspectExecutionIdentityRun({ runId: "ordered-run" }, { ...database, now: admittedAt }),
    ).toMatchObject({
      identity: {
        state: "present",
        context: {
          contextId: "ordered-context",
          agentDefinition: { definitionRef: "main" },
          ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
        },
      },
    });
  });

  it("keeps unavailable worker, schema, and insert failures off the admission path", async () => {
    const envelope = captureExecutionIdentityAdmissionEnvelope(
      {
        runId: "nonblocking-failure-run",
        agentId: "main",
        ingress: { kind: "local-cli", boundary: "agent-command.local" },
        runtime: { kind: "embedded" },
      },
      { runtimeInstanceId: "runtime-1" },
    );

    const unavailableErrors: string[] = [];
    const unavailableWriter = createAuditEventWriter({
      workerUrl: new URL("./missing-audit-event-writer.worker.ts", import.meta.url),
      onError: (error) => unavailableErrors.push(error),
    });
    await unavailableWriter.ready;
    const unavailableStartedAt = performance.now();
    expect(unavailableWriter.recordExecutionIdentity(envelope)).toBe(false);
    expect(performance.now() - unavailableStartedAt).toBeLessThan(250);
    await unavailableWriter.stop();
    expect(unavailableErrors).toContain("audit event writer is unavailable; dropping metadata");

    const schemaStateDir = tempDirs.make("openclaw-audit-writer-");
    const schemaDatabase = { env: { OPENCLAW_STATE_DIR: schemaStateDir } };
    openOpenClawStateDatabase(schemaDatabase).db.exec(`
      DROP TABLE execution_identity_contexts;
      CREATE VIEW execution_identity_contexts AS
      SELECT 'context' AS context_id, 'run' AS run_id, 0 AS created_at,
             'unattributed' AS coverage_state, 2 AS context_bytes, '{}' AS context_json;
    `);
    closeOpenClawStateDatabaseForTest();
    const schemaErrors: string[] = [];
    const schemaWriter = createAuditEventWriter({
      stateDir: schemaStateDir,
      onError: (error) => schemaErrors.push(error),
    });
    const schemaStartedAt = performance.now();
    expect(schemaWriter.recordExecutionIdentity(envelope)).toBe(true);
    expect(performance.now() - schemaStartedAt).toBeLessThan(250);
    await schemaWriter.stop();
    expect(schemaErrors).toContain("audit execution identity persistence failed");

    const insertStateDir = tempDirs.make("openclaw-audit-writer-");
    const insertDatabase = { env: { OPENCLAW_STATE_DIR: insertStateDir } };
    const insertDb = openOpenClawStateDatabase(insertDatabase).db;
    insertDb.exec(`
      CREATE TRIGGER reject_identity_insert
      BEFORE INSERT ON execution_identity_contexts
      BEGIN
        SELECT RAISE(ABORT, 'raw-trigger-secret');
      END;
    `);
    const insertErrors: string[] = [];
    const insertWriter = createAuditEventWriter({
      stateDir: insertStateDir,
      onError: (error) => insertErrors.push(error),
    });
    const insertStartedAt = performance.now();
    expect(insertWriter.recordExecutionIdentity(envelope)).toBe(true);
    expect(performance.now() - insertStartedAt).toBeLessThan(250);
    await insertWriter.stop();
    expect(insertErrors).toContain("audit execution identity persistence failed");
    expect(JSON.stringify(insertErrors)).not.toContain("raw-trigger-secret");
    insertDb.exec("DROP TRIGGER reject_identity_insert;");
    expect(
      inspectExecutionIdentityRun({ runId: envelope.runId }, insertDatabase).identity,
    ).toMatchObject({ state: "unknown", reasonCode: "run_not_found" });
  });

  it("keeps malformed, serialization, key, and persistence failures nonblocking and redaction-safe", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const errors: string[] = [];
    const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });
    const rawSecret = "raw-worker-message-secret";
    const unserializable = {
      ...captureExecutionIdentityAdmissionEnvelope(
        {
          runId: "serialization-run",
          agentId: "main",
          ingress: { kind: "local-cli", boundary: "agent-command.local" },
          runtime: { kind: "embedded" },
        },
        { runtimeInstanceId: "runtime-1" },
      ),
      ingress: {
        kind: "local-cli",
        boundary: "agent-command.local",
        state: "present",
        rawSourceRef: () => rawSecret,
      },
    };
    expect(writer.recordExecutionIdentity(unserializable as never)).toBe(false);
    await writer.stop();
    expect(errors).toContain("audit execution identity envelope could not be queued");
    expect(JSON.stringify(errors)).not.toContain(rawSecret);

    const malformedErrors: string[] = [];
    const malformedWriter = createAuditEventWriter({
      stateDir,
      onError: (error) => malformedErrors.push(error),
    });
    expect(malformedWriter.recordExecutionIdentity({ rawSecret } as never)).toBe(true);
    await malformedWriter.stop();
    expect(malformedErrors).toContain("audit execution identity envelope rejected");
    expect(JSON.stringify(malformedErrors)).not.toContain(rawSecret);

    closeOpenClawStateDatabaseForTest();
    persistExecutionIdentityAdmissionEnvelope(
      captureExecutionIdentityAdmissionEnvelope(
        {
          runId: "before-key-loss",
          agentId: "main",
          ingress: { kind: "local-cli", boundary: "agent-command.local" },
          runtime: { kind: "embedded" },
        },
        { runtimeInstanceId: "runtime-1" },
      ),
      database,
    );
    openOpenClawStateDatabase(database).db.exec("DELETE FROM audit_identity_keys;");
    closeOpenClawStateDatabaseForTest();
    const keyErrors: string[] = [];
    const keyWriter = createAuditEventWriter({
      stateDir,
      onError: (error) => keyErrors.push(error),
    });
    expect(
      keyWriter.recordExecutionIdentity(
        captureExecutionIdentityAdmissionEnvelope(
          {
            runId: "after-key-loss",
            agentId: "main",
            ingress: { kind: "local-cli", boundary: "agent-command.local" },
            runtime: { kind: "embedded" },
          },
          { runtimeInstanceId: rawSecret },
        ),
      ),
    ).toBe(true);
    await keyWriter.stop();
    expect(keyErrors).toContain("audit execution identity key unavailable");
    expect(JSON.stringify(keyErrors)).not.toContain(rawSecret);
    expect(
      inspectExecutionIdentityRun({ runId: "after-key-loss" }, database).identity,
    ).toMatchObject({ state: "unknown", reasonCode: "run_not_found" });
  });
});
