/** Immutable execution identity context storage and run-admission projection. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { Selectable } from "kysely";
import type {
  AuditRunInspectResult,
  DecisionReceiptV1,
  ExecutionIdentityContextV1,
  PrincipalRefV1,
} from "../../packages/gateway-protocol/src/index.js";
import { validateExecutionIdentityContextV1 } from "../../packages/gateway-protocol/src/index.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { listAuditEvents } from "./audit-event-store.js";
import {
  clearAuditIdentityKeyCacheForDatabase,
  pseudonymizeExecutionIdentityRef,
} from "./audit-identity.js";

type ExecutionIdentityDatabase = Pick<OpenClawStateKyselyDatabase, "execution_identity_contexts">;
type ExecutionIdentityRow = Selectable<OpenClawStateKyselyDatabase["execution_identity_contexts"]>;
type ContextIngress = ExecutionIdentityContextV1["ingress"];
type ContextRuntime = ExecutionIdentityContextV1["runtimeInstance"];
type ContextAssurance = ExecutionIdentityContextV1["assurance"][number];

const EXECUTION_IDENTITY_CONTEXT_MAX_BYTES = 16 * 1024;
const EXECUTION_IDENTITY_CONTEXT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const EXECUTION_IDENTITY_CONTEXT_MAX_ROWS = 100_000;
const EXECUTION_IDENTITY_CONTEXT_PRUNE_BATCH_ROWS = 1_024;
const EXECUTION_IDENTITY_HMAC_REF_RE = /^hmac-sha256:v1:[a-f0-9]{32}:[a-f0-9]{64}$/u;
const PROCESS_RUNTIME_INSTANCE_ID = randomUUID();
const log = createSubsystemLogger("audit/events");

const ensuredDatabases = new WeakSet<DatabaseSync>();
const contextRowCounts = new WeakMap<DatabaseSync, number>();
let persistenceFailureWarned = false;

// Keep this feature-local DDL byte-for-byte aligned with the canonical schema.
const EXECUTION_IDENTITY_CONTEXT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_identity_contexts (
  context_id TEXT NOT NULL PRIMARY KEY CHECK (length(context_id) BETWEEN 1 AND 256),
  run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  coverage_state TEXT NOT NULL CHECK (
    coverage_state IN ('attribution-only', 'unattributed', 'unknown', 'unsupported')
  ),
  context_bytes INTEGER NOT NULL CHECK (context_bytes BETWEEN 1 AND 16384),
  context_json TEXT NOT NULL CHECK (length(context_json) > 0),
  UNIQUE (created_at, context_id)
) STRICT;
`;

export type ExecutionIdentityAdmissionFacts = {
  runId: string;
  agentId: string;
  ingress: {
    kind: ContextIngress["kind"];
    boundary: string;
    state?: ContextIngress["state"];
    rawSourceRef?: string;
  };
  runtime: {
    kind: ContextRuntime["kind"];
  };
  invoker?: {
    kind: PrincipalRefV1["kind"];
    rawPrincipalRef: string;
    displayLabel?: string;
  };
  applicableGrants?: Array<{
    rawGrantRef: string;
    state: ExecutionIdentityContextV1["applicableGrants"][number]["state"];
  }>;
  assurance?: Array<{
    kind: ContextAssurance["kind"];
    rawEvidenceRef: string;
    strength: ContextAssurance["strength"];
  }>;
};

type ExecutionIdentityStoreOptions = OpenClawStateDatabaseOptions & {
  now?: number;
  contextId?: string;
  runtimeInstanceId?: string;
  limits?: {
    maxRows: number;
    pruneBatchRows: number;
  };
};

type ExecutionIdentityContextReadResult =
  | { status: "found"; context: ExecutionIdentityContextV1 }
  | { status: "missing" }
  | { status: "corrupt"; reasonCode: "identity_context_corrupt" };

function executionIdentityDb(db: DatabaseSync) {
  return getNodeSqliteKysely<ExecutionIdentityDatabase>(db);
}

function ensureBoundedRef(value: string, label: string, maxLength = 256): string {
  if (!value || value.length > maxLength) {
    throw new Error(`${label} must be between 1 and ${String(maxLength)} characters`);
  }
  return value;
}

function ensureRawRef(value: string, label: string): string {
  return ensureBoundedRef(value, label, 4_096);
}

function freezeContext<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeContext(nested, seen);
  }
  return Object.freeze(value);
}

function ensureExecutionIdentityContextSchema(options: OpenClawStateDatabaseOptions = {}): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; context rows use Kysely.
      db.exec(EXECUTION_IDENTITY_CONTEXT_SCHEMA_SQL);
    },
    options,
    { operationLabel: "audit.execution-identity.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}

function hmacRef(
  db: DatabaseSync,
  kind: Parameters<typeof pseudonymizeExecutionIdentityRef>[0]["kind"],
  scope: string,
  value: string,
): string {
  return pseudonymizeExecutionIdentityRef({
    db,
    kind,
    scope: ensureBoundedRef(scope, "HMAC scope"),
    value: ensureRawRef(value, "HMAC value"),
  });
}

function uniqueSorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()].toSorted((a, b) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function buildExecutionIdentityContext(
  db: DatabaseSync,
  facts: ExecutionIdentityAdmissionFacts,
  fixed: { contextId: string; createdAt: number; runtimeInstanceId: string },
): ExecutionIdentityContextV1 {
  const runId = ensureBoundedRef(facts.runId, "run id");
  const agentId = ensureBoundedRef(facts.agentId, "agent id");
  const contextId = ensureBoundedRef(fixed.contextId, "context id");
  const domainRef = hmacRef(db, "domain", "gateway-cell", "gateway-cell");
  const runtimeRef = hmacRef(
    db,
    "runtime",
    domainRef,
    ensureRawRef(fixed.runtimeInstanceId, "runtime instance id"),
  );
  const invoker = facts.invoker
    ? {
        state: "present" as const,
        principal: {
          kind: facts.invoker.kind,
          domainRef,
          principalRef: hmacRef(
            db,
            "principal",
            `${domainRef}:${facts.invoker.kind}`,
            facts.invoker.rawPrincipalRef,
          ),
          ...(facts.invoker.displayLabel !== undefined
            ? {
                displayLabel: truncateUtf16Safe(
                  redactSensitiveText(facts.invoker.displayLabel, { mode: "tools" }),
                  128,
                ),
              }
            : {}),
        },
      }
    : { state: "absent" as const };
  const assuranceInputs = facts.assurance ?? [
    {
      kind: "runtime-binding" as const,
      rawEvidenceRef: fixed.runtimeInstanceId,
      strength: "boundary-verified" as const,
    },
  ];
  if (assuranceInputs.length > 16) {
    throw new Error("execution identity assurance exceeds 16 items");
  }
  if ((facts.applicableGrants?.length ?? 0) > 16) {
    throw new Error("execution identity grants exceed 16 items");
  }
  const assurance = uniqueSorted(
    assuranceInputs.map((item) => ({
      kind: item.kind,
      evidenceRef: hmacRef(db, "evidence", `${domainRef}:${item.kind}`, item.rawEvidenceRef),
      strength: item.strength,
    })),
    (item) => `${item.kind}\0${item.evidenceRef}\0${item.strength}`,
  );
  const applicableGrants = uniqueSorted(
    (facts.applicableGrants ?? []).map((grant) => ({
      grantRef: hmacRef(db, "grant", domainRef, grant.rawGrantRef),
      state: grant.state,
    })),
    (grant) => `${grant.grantRef}\0${grant.state}`,
  );
  const missingEvidence = facts.invoker ? [] : ["invoker.principal"];
  const context: ExecutionIdentityContextV1 = {
    schemaVersion: 1,
    contextId,
    runId,
    createdAt: fixed.createdAt,
    trustDomain: { kind: "gateway-cell", domainRef, state: "present" },
    invoker,
    ingress: {
      kind: facts.ingress.kind,
      boundary: ensureBoundedRef(facts.ingress.boundary, "ingress boundary"),
      state: facts.ingress.state ?? "present",
      ...(facts.ingress.rawSourceRef
        ? {
            sourceRef: hmacRef(
              db,
              "principal",
              `${domainRef}:ingress:${facts.ingress.kind}`,
              facts.ingress.rawSourceRef,
            ),
          }
        : {}),
    },
    agentPrincipal: { kind: "agent", domainRef, principalRef: agentId },
    agentDefinition: { definitionRef: agentId, state: "present" },
    runtimeInstance: { runtimeRef, kind: facts.runtime.kind, state: "present" },
    applicableGrants,
    assurance,
    coverageState: facts.invoker ? "attribution-only" : "unattributed",
    missingEvidence,
  };
  if (!validateExecutionIdentityContextV1(context)) {
    throw new Error("prepared execution identity context violates the V1 contract");
  }
  const encoded = JSON.stringify(context);
  if (Buffer.byteLength(encoded, "utf8") > EXECUTION_IDENTITY_CONTEXT_MAX_BYTES) {
    throw new Error("prepared execution identity context exceeds 16 KiB");
  }
  return freezeContext(context);
}

function parseExecutionIdentityRow(row: ExecutionIdentityRow): ExecutionIdentityContextV1 {
  if (
    typeof row.context_json !== "string" ||
    Buffer.byteLength(row.context_json, "utf8") !== normalizeSqliteNumber(row.context_bytes) ||
    Buffer.byteLength(row.context_json, "utf8") > EXECUTION_IDENTITY_CONTEXT_MAX_BYTES
  ) {
    throw new Error("invalid context payload bounds");
  }
  const parsed = JSON.parse(row.context_json) as unknown;
  if (!validateExecutionIdentityContextV1(parsed)) {
    throw new Error("invalid context payload schema");
  }
  if (
    parsed.contextId !== row.context_id ||
    parsed.runId !== row.run_id ||
    parsed.createdAt !== normalizeSqliteNumber(row.created_at) ||
    parsed.coverageState !== row.coverage_state ||
    JSON.stringify(parsed) !== row.context_json ||
    !EXECUTION_IDENTITY_HMAC_REF_RE.test(parsed.trustDomain.domainRef) ||
    !EXECUTION_IDENTITY_HMAC_REF_RE.test(parsed.runtimeInstance.runtimeRef)
  ) {
    throw new Error("context payload disagrees with indexed columns");
  }
  return freezeContext(parsed);
}

function readRowByRunId(db: DatabaseSync, runId: string): ExecutionIdentityRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    executionIdentityDb(db)
      .selectFrom("execution_identity_contexts")
      .selectAll()
      .where("run_id", "=", runId),
  );
}

function countExecutionIdentityContexts(db: DatabaseSync): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    executionIdentityDb(db)
      .selectFrom("execution_identity_contexts")
      .select((expression) => expression.fn.countAll<number>().as("count")),
  );
  return normalizeSqliteNumber(row?.count ?? null) ?? 0;
}

function pruneExecutionIdentityContextsAfterInsert(
  db: DatabaseSync,
  now: number,
  limits: { maxRows: number; pruneBatchRows: number },
): void {
  const kysely = executionIdentityDb(db);
  const expiredIds = kysely
    .selectFrom("execution_identity_contexts")
    .select("context_id")
    .where("created_at", "<", now - EXECUTION_IDENTITY_CONTEXT_RETENTION_MS)
    .orderBy("created_at", "asc")
    .orderBy("context_id", "asc")
    .limit(limits.pruneBatchRows);
  const expired = executeSqliteQuerySync(
    db,
    kysely.deleteFrom("execution_identity_contexts").where("context_id", "in", expiredIds),
  );
  const expiredCount = Number(expired.numAffectedRows ?? 0n);
  const cached = contextRowCounts.get(db);
  let rowCount =
    cached === undefined
      ? countExecutionIdentityContexts(db)
      : Math.max(0, cached + 1 - expiredCount);
  const remainingPruneBudget = Math.max(0, limits.pruneBatchRows - expiredCount);
  if (rowCount > limits.maxRows && remainingPruneBudget > 0) {
    const deleteCount = Math.min(remainingPruneBudget, rowCount - limits.maxRows);
    const oldestIds = kysely
      .selectFrom("execution_identity_contexts")
      .select("context_id")
      .orderBy("created_at", "asc")
      .orderBy("context_id", "asc")
      .limit(deleteCount);
    const pruned = executeSqliteQuerySync(
      db,
      kysely.deleteFrom("execution_identity_contexts").where("context_id", "in", oldestIds),
    );
    rowCount = Math.max(0, rowCount - Number(pruned.numAffectedRows ?? 0n));
  }
  contextRowCounts.set(db, rowCount);
}

/** Prepare and synchronously persist the immutable context at run admission. */
export function prepareExecutionIdentityContextAtAdmission(
  facts: ExecutionIdentityAdmissionFacts,
  options: ExecutionIdentityStoreOptions = {},
): ExecutionIdentityContextV1 {
  ensureExecutionIdentityContextSchema(options);
  const runId = ensureBoundedRef(facts.runId, "run id");
  const opened = openOpenClawStateDatabase(options);
  const observed = readRowByRunId(opened.db, runId);
  const observedContext = observed ? parseExecutionIdentityRow(observed) : undefined;
  // HMAC lookup/key creation and canonical serialization finish before BEGIN.
  // The transaction only rereads the authoritative row and synchronously commits.
  const plannedContext = buildExecutionIdentityContext(opened.db, facts, {
    contextId: observedContext?.contextId ?? options.contextId ?? randomUUID(),
    createdAt: observedContext?.createdAt ?? options.now ?? Date.now(),
    runtimeInstanceId: options.runtimeInstanceId ?? PROCESS_RUNTIME_INSTANCE_ID,
  });
  let transactionDatabase: DatabaseSync | undefined;
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        transactionDatabase = db;
        const existing = readRowByRunId(db, runId);
        if (existing) {
          const context = parseExecutionIdentityRow(existing);
          const expected = {
            ...plannedContext,
            contextId: context.contextId,
            createdAt: context.createdAt,
          } satisfies ExecutionIdentityContextV1;
          if (JSON.stringify(expected) !== existing.context_json) {
            throw new Error(`execution identity context conflict for run ${runId}`);
          }
          return context;
        }
        const contextJson = JSON.stringify(plannedContext);
        executeSqliteQuerySync(
          db,
          executionIdentityDb(db)
            .insertInto("execution_identity_contexts")
            .values({
              context_id: plannedContext.contextId,
              run_id: plannedContext.runId,
              created_at: plannedContext.createdAt,
              coverage_state: plannedContext.coverageState,
              context_bytes: Buffer.byteLength(contextJson, "utf8"),
              context_json: contextJson,
            }),
        );
        pruneExecutionIdentityContextsAfterInsert(
          db,
          options.now ?? Date.now(),
          options.limits ?? {
            maxRows: EXECUTION_IDENTITY_CONTEXT_MAX_ROWS,
            pruneBatchRows: EXECUTION_IDENTITY_CONTEXT_PRUNE_BATCH_ROWS,
          },
        );
        return plannedContext;
      },
      options,
      { operationLabel: "audit.execution-identity.context.record" },
    );
  } catch (error) {
    if (transactionDatabase) {
      contextRowCounts.delete(transactionDatabase);
      clearAuditIdentityKeyCacheForDatabase(transactionDatabase);
    }
    throw error;
  }
}

/** Best-effort admission recording. Disabled collection and write failures never block a run. */
export function recordExecutionIdentityContextAtAdmission(
  facts: ExecutionIdentityAdmissionFacts,
  options: ExecutionIdentityStoreOptions & { enabled: boolean },
): ExecutionIdentityContextV1 | undefined {
  const { enabled, ...storeOptions } = options;
  if (!enabled) {
    return undefined;
  }
  try {
    return prepareExecutionIdentityContextAtAdmission(facts, storeOptions);
  } catch {
    if (!persistenceFailureWarned) {
      persistenceFailureWarned = true;
      log.warn(
        "audit execution identity persistence failed; continuing without exact-run identity context",
      );
    }
    return undefined;
  }
}

/** Read one exact run context while turning malformed rows into typed diagnostics. */
function readExecutionIdentityContextByRunId(
  runId: string,
  options: OpenClawStateDatabaseOptions = {},
): ExecutionIdentityContextReadResult {
  const normalizedRunId = ensureBoundedRef(runId, "run id");
  ensureExecutionIdentityContextSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  const row = readRowByRunId(db, normalizedRunId);
  if (!row) {
    return { status: "missing" };
  }
  try {
    return { status: "found", context: parseExecutionIdentityRow(row) };
  } catch {
    return { status: "corrupt", reasonCode: "identity_context_corrupt" };
  }
}

function admissionDecision(context: ExecutionIdentityContextV1): DecisionReceiptV1 {
  return {
    schemaVersion: 1,
    receiptId: `${context.contextId}:admission`,
    contextId: context.contextId,
    runId: context.runId,
    occurredAt: context.createdAt,
    action: {
      family: "run",
      operation: "admission",
      summary: "Run admission was recorded without an identity-aware policy or grant decision.",
    },
    decision: {
      outcome: "not-applicable",
      reasonCode: "run_admission_identity_not_evaluated",
    },
    enforcement: {
      coverageState: context.coverageState,
      policyRefs: [],
      grantRefs: [],
      contextFieldsUsed: [],
    },
    source: {
      owner: "agent-command",
      recordRef: context.contextId,
      decisionBoundary: "agent-command.run-admission",
    },
    missingEvidence: [...context.missingEvidence],
    remediation: [
      {
        code: "no_identity_enforcement_claimed",
        text: "Treat this receipt as attribution only; it does not prove authorization.",
      },
    ],
  };
}

function unavailableResult(params: {
  runId: string;
  runStatus: "known" | "unknown";
  state: "unknown" | "unsupported";
  reasonCode: string;
  missingEvidence: string[];
  remediation: Array<{ code: string; text: string }>;
}): AuditRunInspectResult {
  return {
    schemaVersion: 1,
    run: { runId: params.runId, status: params.runStatus },
    identity: {
      state: params.state,
      reasonCode: params.reasonCode,
      missingEvidence: params.missingEvidence,
      remediation: params.remediation,
    },
    decisions: [],
    coverage: { state: params.state, missingEvidence: params.missingEvidence },
  };
}

/** Project one exact run plus the truthful run-admission decision receipt. */
export function inspectExecutionIdentityRun(
  params: { runId: string; decisionOffset?: number; decisionLimit?: number },
  options: OpenClawStateDatabaseOptions = {},
): AuditRunInspectResult {
  const runId = ensureBoundedRef(params.runId, "run id");
  const contextResult = readExecutionIdentityContextByRunId(runId, options);
  if (contextResult.status === "found") {
    const allDecisions = [admissionDecision(contextResult.context)];
    const offset = params.decisionOffset ?? 0;
    const limit = params.decisionLimit ?? 50;
    const decisions = allDecisions.slice(offset, offset + limit);
    const nextOffset = offset + decisions.length;
    return {
      schemaVersion: 1,
      run: { runId, status: "known" },
      identity: { state: "present", context: contextResult.context },
      decisions,
      coverage: {
        state: contextResult.context.coverageState,
        missingEvidence: [...contextResult.context.missingEvidence],
      },
      ...(nextOffset < allDecisions.length ? { nextDecisionCursor: String(nextOffset) } : {}),
    };
  }
  if (contextResult.status === "corrupt") {
    return unavailableResult({
      runId,
      runStatus: "known",
      state: "unknown",
      reasonCode: contextResult.reasonCode,
      missingEvidence: ["identity.context.valid"],
      remediation: [
        {
          code: "inspect_state_integrity",
          text: "Run openclaw doctor and inspect the shared state database before trusting this run.",
        },
      ],
    });
  }
  try {
    const auditPage = listAuditEvents({
      limit: 1,
      filters: { runId },
      database: options,
    });
    if (auditPage.events.length > 0) {
      return unavailableResult({
        runId,
        runStatus: "known",
        state: "unsupported",
        reasonCode: "identity_context_unavailable",
        missingEvidence: ["identity.context"],
        remediation: [
          {
            code: "run_again_after_upgrade",
            text: "Run the operation again on a current Gateway to record execution identity context.",
          },
        ],
      });
    }
  } catch {
    return unavailableResult({
      runId,
      runStatus: "unknown",
      state: "unknown",
      reasonCode: "run_evidence_unreadable",
      missingEvidence: ["run.record", "identity.context"],
      remediation: [
        {
          code: "inspect_state_integrity",
          text: "Run openclaw doctor and retry the exact run inspection.",
        },
      ],
    });
  }
  return unavailableResult({
    runId,
    runStatus: "unknown",
    state: "unknown",
    reasonCode: "run_not_found",
    missingEvidence: ["run.record", "identity.context"],
    remediation: [
      {
        code: "verify_run_id",
        text: "Verify the exact run id; absence of best-effort audit activity is not proof of no run.",
      },
    ],
  });
}
