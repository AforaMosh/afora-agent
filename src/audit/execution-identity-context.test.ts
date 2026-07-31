import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { recordAuditEvent } from "./audit-event-store.js";
import {
  inspectExecutionIdentityRun,
  prepareExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionFacts,
} from "./execution-identity-context.js";

const tempDirs: string[] = [];
const RETENTION_MS = 30 * 24 * 60 * 60_000;

function databaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "openclaw-identity-") } };
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

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

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
    const afterRestart = inspectExecutionIdentityRun({ runId: "run-1" }, database);
    expect(afterRestart.identity).toEqual({ state: "present", context: first });
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

  it("fails closed when one run id is reused with different identity facts", () => {
    const database = databaseOptions();
    const options = { ...database, runtimeInstanceId: "runtime-1" };
    prepareExecutionIdentityContextAtAdmission(facts("run-conflict"), options);
    expect(() =>
      prepareExecutionIdentityContextAtAdmission(
        facts("run-conflict", { agentId: "other" }),
        options,
      ),
    ).toThrow("execution identity context conflict");
  });

  it("fails closed instead of rotating a missing HMAC key with retained contexts", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-before-key-loss"), database);
    openOpenClawStateDatabase(database).db.exec("DELETE FROM audit_identity_keys;");
    closeOpenClawStateDatabaseForTest();

    expect(() =>
      prepareExecutionIdentityContextAtAdmission(facts("run-after-key-loss"), database),
    ).toThrow("audit identity key is missing");
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
      identity: { state: "unknown", reasonCode: "run_not_found" },
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
      identity: { state: "unsupported", reasonCode: "identity_context_unavailable" },
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
    const result = inspectExecutionIdentityRun({ runId: "run-receipt" }, database);

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
      inspectExecutionIdentityRun({ runId: "run-receipt", decisionOffset: 1 }, database).decisions,
    ).toEqual([]);
  });
});
