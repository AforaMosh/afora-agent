import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { recordAuditEvent } from "./audit-event-store.js";
import {
  inspectExecutionIdentityRun,
  pruneExpiredExecutionIdentityContexts,
  recordExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionFacts,
} from "./execution-identity-context.js";

const RETENTION_MS = 30 * 24 * 60 * 60_000;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-identity-") } };
}

function facts(
  runId: string,
  overrides: Partial<ExecutionIdentityAdmissionFacts> = {},
): ExecutionIdentityAdmissionFacts {
  return {
    runId,
    agentId: "main",
    ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
    runtime: { kind: "embedded" },
    ...overrides,
  };
}

function prepareExecutionIdentityContextAtAdmission(
  admissionFacts: ExecutionIdentityAdmissionFacts,
  options: Omit<Parameters<typeof recordExecutionIdentityContextAtAdmission>[1], "enabled"> = {},
) {
  const context = recordExecutionIdentityContextAtAdmission(admissionFacts, {
    ...options,
    enabled: true,
  });
  if (!context) {
    throw new Error("expected execution identity context to be recorded");
  }
  return context;
}

describe("execution identity context storage", () => {
  it("persists one frozen unattributed context idempotently across restart", () => {
    const database = databaseOptions();
    const options = {
      ...database,
      now: 100,
      contextId: "context-1",
      runtimeInstanceId: "runtime-secret-1",
    };
    const first = prepareExecutionIdentityContextAtAdmission(facts("run-1"), options);
    const second = prepareExecutionIdentityContextAtAdmission(facts("run-1"), {
      ...options,
      now: 999,
      contextId: "ignored-on-idempotent-read",
    });

    expect(second).toEqual(first);
    expect(first.coverageState).toBe("unattributed");
    expect(first.invoker).toEqual({ state: "absent" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.runtimeInstance)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("runtime-secret-1");

    closeOpenClawStateDatabaseForTest();
    const afterRestart = inspectExecutionIdentityRun(
      { runId: "run-1" },
      {
        ...database,
        now: 999,
      },
    );
    expect(afterRestart.identity).toEqual({ state: "present", context: first });
  });

  it("projects authoritative local CLI and system ingress without conflating them", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-local"), database);
    prepareExecutionIdentityContextAtAdmission(
      facts("run-system", {
        ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
      }),
      database,
    );

    expect(inspectExecutionIdentityRun({ runId: "run-local" }, database).identity).toMatchObject({
      state: "present",
      context: {
        ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
      },
    });
    expect(inspectExecutionIdentityRun({ runId: "run-system" }, database).identity).toMatchObject({
      state: "present",
      context: {
        ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
      },
    });
  });

  it("lazily restores the additive table on an existing current-schema database", () => {
    const database = databaseOptions();
    const opened = openOpenClawStateDatabase(database);
    opened.db.exec("DROP TABLE execution_identity_contexts;");
    closeOpenClawStateDatabaseForTest();

    const reopened = openOpenClawStateDatabase(database);
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toBeUndefined();
    expect(inspectExecutionIdentityRun({ runId: "missing" }, database)).toMatchObject({
      run: { status: "unknown" },
      identity: { state: "unknown", reasonCode: "run_not_found" },
    });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toEqual({ name: "execution_identity_contexts" });
  });

  it("records attribution only when an invoker fact is actually present", () => {
    const database = databaseOptions();
    const context = prepareExecutionIdentityContextAtAdmission(
      facts("run-attributed", {
        invoker: {
          kind: "local-account",
          rawPrincipalRef: "private-local-account",
          displayLabel: "Operator OPENAI_API_KEY=sk-1234567890abcdef",
        },
        applicableGrants: [
          { rawGrantRef: "grant-z", state: "present" },
          { rawGrantRef: "grant-a", state: "present" },
        ],
        assurance: [
          {
            kind: "local-process",
            rawEvidenceRef: "private-process-evidence",
            strength: "boundary-verified",
          },
        ],
      }),
      { ...database, runtimeInstanceId: "private-runtime" },
    );
    const encoded = JSON.stringify(context);

    expect(context.coverageState).toBe("attribution-only");
    expect(context.invoker.state).toBe("present");
    expect(context.missingEvidence).toEqual([]);
    expect(context.applicableGrants.map((grant) => grant.grantRef)).toEqual(
      context.applicableGrants.map((grant) => grant.grantRef).toSorted(),
    );
    for (const secret of [
      "private-local-account",
      "private-process-evidence",
      "private-runtime",
      "grant-a",
      "grant-z",
      "sk-1234567890abcdef",
    ]) {
      expect(encoded).not.toContain(secret);
    }
    expect(context.invoker.principal?.principalRef).toMatch(/^hmac-sha256:v1:/u);
  });

  it("rejects conflicting identity facts without replacing the original context", () => {
    const database = databaseOptions();
    const options = { ...database, runtimeInstanceId: "runtime-1" };
    const original = prepareExecutionIdentityContextAtAdmission(facts("run-conflict"), options);
    expect(
      recordExecutionIdentityContextAtAdmission(facts("run-conflict", { agentId: "other" }), {
        ...options,
        enabled: true,
      }),
    ).toBeUndefined();
    expect(inspectExecutionIdentityRun({ runId: "run-conflict" }, database).identity).toEqual({
      state: "present",
      context: original,
    });
  });

  it("declines recording instead of rotating a missing HMAC key with retained contexts", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-before-key-loss"), database);
    openOpenClawStateDatabase(database).db.exec("DELETE FROM audit_identity_keys;");
    closeOpenClawStateDatabaseForTest();

    expect(
      recordExecutionIdentityContextAtAdmission(facts("run-after-key-loss"), {
        ...database,
        enabled: true,
      }),
    ).toBeUndefined();
  });

  it("skips new context rows when audit collection is disabled", () => {
    const database = databaseOptions();

    expect(
      recordExecutionIdentityContextAtAdmission(facts("run-disabled"), {
        ...database,
        enabled: false,
      }),
    ).toBeUndefined();

    const rowCount = openOpenClawStateDatabase(database)
      .db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts")
      .get() as { count: number };
    expect(rowCount.count).toBe(0);
  });

  it("keeps bounded retention maintenance available while collection is disabled", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-before-disable"), {
      ...database,
      now: 0,
      runtimeInstanceId: "runtime-1",
    });
    expect(
      recordExecutionIdentityContextAtAdmission(facts("run-disabled"), {
        ...database,
        enabled: false,
        now: RETENTION_MS + 1,
      }),
    ).toBeUndefined();

    expect(pruneExpiredExecutionIdentityContexts({ database, now: RETENTION_MS + 1 })).toBe(1);
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("keeps admission available when context persistence fails", () => {
    const database = databaseOptions();
    const options = { ...database, runtimeInstanceId: "runtime-1" };
    prepareExecutionIdentityContextAtAdmission(facts("run-best-effort"), options);

    expect(
      recordExecutionIdentityContextAtAdmission(
        facts("run-best-effort", { agentId: "conflicting-agent" }),
        { ...options, enabled: true },
      ),
    ).toBeUndefined();
  });

  it("keeps admission available when insert-time retention cleanup fails", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-expired"), {
      ...database,
      now: 0,
      runtimeInstanceId: "runtime-1",
    });
    openOpenClawStateDatabase(database).db.exec(`
      CREATE TRIGGER reject_identity_cleanup
      BEFORE DELETE ON execution_identity_contexts
      BEGIN
        SELECT RAISE(ABORT, 'cleanup unavailable');
      END;
    `);

    expect(
      recordExecutionIdentityContextAtAdmission(facts("run-still-admitted"), {
        ...database,
        enabled: true,
        now: RETENTION_MS + 1,
        runtimeInstanceId: "runtime-1",
      }),
    ).toBeUndefined();
  });

  it("stops projecting context and decisions immediately after the retention boundary", () => {
    const database = databaseOptions();
    const createdAt = 1_000;
    prepareExecutionIdentityContextAtAdmission(facts("run-retention"), {
      ...database,
      now: createdAt,
      contextId: "expired-context-secret",
      runtimeInstanceId: "expired-runtime-secret",
    });

    const immediatelyBefore = inspectExecutionIdentityRun(
      { runId: "run-retention" },
      { ...database, now: createdAt + RETENTION_MS - 1 },
    );
    expect(immediatelyBefore.identity).toMatchObject({
      state: "present",
      context: { contextId: "expired-context-secret" },
    });
    expect(immediatelyBefore.decisions).toHaveLength(1);
    expect(
      inspectExecutionIdentityRun(
        { runId: "run-retention" },
        { ...database, now: createdAt + RETENTION_MS },
      ).identity.state,
    ).toBe("present");

    const immediatelyAfter = inspectExecutionIdentityRun(
      { runId: "run-retention" },
      { ...database, now: createdAt + RETENTION_MS + 1 },
    );
    expect(immediatelyAfter).toMatchObject({
      run: { status: "known" },
      identity: {
        state: "unsupported",
        reasonCode: "identity_context_unavailable",
        remediation: [
          expect.objectContaining({
            code: "run_again_after_expiry",
            text: expect.stringContaining("outside the 30-day retention window"),
          }),
        ],
      },
      decisions: [],
      coverage: { state: "unsupported", missingEvidence: ["identity.context"] },
    });
    expect(JSON.stringify(immediatelyAfter)).not.toContain("expired-context-secret");
    expect(JSON.stringify(immediatelyAfter)).not.toContain("expired-runtime-secret");
    expect(JSON.stringify(immediatelyAfter)).not.toContain("run_admission_identity_not_evaluated");

    closeOpenClawStateDatabaseForTest();
    expect(
      inspectExecutionIdentityRun(
        { runId: "run-retention" },
        { ...database, now: createdAt + RETENTION_MS + 1 },
      ),
    ).toEqual(immediatelyAfter);

    expect(
      pruneExpiredExecutionIdentityContexts({
        database,
        now: createdAt + RETENTION_MS + 1,
      }),
    ).toBe(1);
    expect(
      inspectExecutionIdentityRun(
        { runId: "run-retention" },
        { ...database, now: createdAt + RETENTION_MS + 1 },
      ),
    ).toMatchObject({
      run: { status: "unknown" },
      identity: {
        state: "unknown",
        reasonCode: "run_not_found",
        remediation: [
          expect.objectContaining({ text: expect.stringContaining("not proof of no run") }),
        ],
      },
      decisions: [],
    });
  });

  it("prunes expired contexts in bounded maintenance batches without new inserts", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("schema-seed"), {
      ...database,
      now: 1,
      runtimeInstanceId: "runtime-1",
    });
    const { db } = openOpenClawStateDatabase(database);
    db.exec("DELETE FROM execution_identity_contexts;");
    db.prepare(
      `WITH RECURSIVE rows(n) AS (
         VALUES (1)
         UNION ALL
         SELECT n + 1 FROM rows WHERE n < 1025
       )
       INSERT INTO execution_identity_contexts (
         context_id, run_id, created_at, coverage_state, context_bytes, context_json
       )
       SELECT 'context-' || n, 'run-' || n, 0, 'unattributed', 2, '{}'
       FROM rows`,
    ).run();

    expect(pruneExpiredExecutionIdentityContexts({ database, now: RETENTION_MS + 1 })).toBe(1_024);
    expect(db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts").get()).toEqual({
      count: 1,
    });
    expect(pruneExpiredExecutionIdentityContexts({ database, now: RETENTION_MS + 1 })).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts").get()).toEqual({
      count: 0,
    });
  });

  it("prunes retention and row-cap overflow in bounded batches", () => {
    const retentionDatabase = databaseOptions();
    for (const runId of ["old-1", "old-2", "old-3"]) {
      prepareExecutionIdentityContextAtAdmission(facts(runId), {
        ...retentionDatabase,
        now: 0,
        runtimeInstanceId: "runtime-1",
        limits: { maxRows: 10, pruneBatchRows: 1 },
      });
    }
    prepareExecutionIdentityContextAtAdmission(facts("new-1"), {
      ...retentionDatabase,
      now: RETENTION_MS + 1,
      runtimeInstanceId: "runtime-1",
      limits: { maxRows: 1, pruneBatchRows: 1 },
    });
    const retainedAfterOneBatch = openOpenClawStateDatabase(retentionDatabase)
      .db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts")
      .get() as { count: number };
    expect(retainedAfterOneBatch.count).toBe(3);

    const capDatabase = databaseOptions();
    for (const runId of ["cap-1", "cap-2", "cap-3"]) {
      prepareExecutionIdentityContextAtAdmission(facts(runId), {
        ...capDatabase,
        now: 100,
        contextId: `context-${runId}`,
        runtimeInstanceId: "runtime-1",
        limits: { maxRows: 2, pruneBatchRows: 1 },
      });
    }
    const capped = openOpenClawStateDatabase(capDatabase)
      .db.prepare("SELECT run_id FROM execution_identity_contexts ORDER BY context_id")
      .all() as Array<{ run_id: string }>;
    expect(capped).toHaveLength(2);
    expect(capped.map((row) => row.run_id)).not.toContain("cap-1");
  });

  it("returns typed corrupt, unknown, and unsupported projections", () => {
    const corruptDatabase = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-corrupt"), {
      ...corruptDatabase,
      runtimeInstanceId: "runtime-1",
    });
    openOpenClawStateDatabase(corruptDatabase)
      .db.prepare("UPDATE execution_identity_contexts SET context_json = ? WHERE run_id = ?")
      .run("{", "run-corrupt");
    expect(inspectExecutionIdentityRun({ runId: "run-corrupt" }, corruptDatabase)).toMatchObject({
      run: { status: "known" },
      identity: { state: "unknown", reasonCode: "identity_context_corrupt" },
      coverage: { state: "unknown" },
    });

    const unknownDatabase = databaseOptions();
    expect(inspectExecutionIdentityRun({ runId: "never-seen" }, unknownDatabase)).toMatchObject({
      run: { status: "unknown" },
      identity: {
        state: "unknown",
        reasonCode: "run_not_found",
        remediation: [expect.objectContaining({ code: "verify_run_id" })],
      },
    });

    recordAuditEvent(
      {
        sourceId: "legacy-run:1",
        sourceSequence: 1,
        occurredAt: Date.now(),
        kind: "agent_run",
        action: "agent.run.started",
        status: "started",
        actorType: "agent",
        actorId: "main",
        agentId: "main",
        runId: "legacy-run",
      },
      unknownDatabase,
    );
    expect(inspectExecutionIdentityRun({ runId: "legacy-run" }, unknownDatabase)).toMatchObject({
      run: { status: "known" },
      identity: {
        state: "unsupported",
        reasonCode: "identity_context_unavailable",
        remediation: [expect.objectContaining({ code: "record_new_identity_context" })],
      },
    });
  });

  it("projects one non-enforcement admission explanation", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-receipt"), {
      ...database,
      now: 123,
      contextId: "context-receipt",
      runtimeInstanceId: "runtime-1",
    });
    const result = inspectExecutionIdentityRun({ runId: "run-receipt" }, { ...database, now: 123 });

    expect(result.identity).toMatchObject({
      state: "present",
      context: { contextId: "context-receipt", coverageState: "unattributed" },
    });
    expect(result.decisions).toEqual([
      expect.objectContaining({
        decision: {
          outcome: "not-applicable",
          reasonCode: "run_admission_identity_not_evaluated",
        },
        enforcement: expect.objectContaining({
          coverageState: "unattributed",
          policyRefs: [],
          grantRefs: [],
          contextFieldsUsed: [],
        }),
      }),
    ]);
    expect(
      inspectExecutionIdentityRun(
        { runId: "run-receipt", decisionOffset: 1 },
        { ...database, now: 123 },
      ).decisions,
    ).toEqual([]);
  });
});
