// QA Lab producer proves exact-run identity inspection through a real local turn and Gateway.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/src/evidence-summary.js";
import { startQaGatewayChild } from "../../../../extensions/qa-lab/src/gateway-child.js";
import { startQaMockOpenAiServer } from "../../../../extensions/qa-lab/src/providers/mock-openai/server.js";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { createQaScriptEvidenceWriter, type QaScriptEvidenceStatus } from "./script-evidence.js";

const SCENARIO_ID = "agent-run-identity-inspection";
const SNAPSHOT_FILE = `${SCENARIO_ID}-summary.json`;
const TEXT_SECTIONS = [
  "Identity",
  "Authority",
  "Lineage",
  "Decisions",
  "Missing evidence",
  "Next steps",
] as const;
const IDENTITY_FIELDS = [
  "Trust domain",
  "Invoker",
  "Ingress",
  "Agent principal",
  "Agent definition",
  "Runtime instance",
  "Represented subject",
  "Sponsor",
  "Applicable grants",
  "Assurance",
] as const;

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
};

type ProofResult = {
  artifacts?: Array<{ filePath: string; kind: string }>;
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};

function parseOptions(argv: readonly string[]): ProducerOptions {
  const readValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const artifactBase = readValue("--artifact-base");
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return {
    artifactBase: path.resolve(artifactBase),
    repoRoot: path.resolve(readValue("--repo-root") ?? process.cwd()),
  };
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${label} was not JSON: ${formatErrorMessage(error)}`);
  }
}

function requireIdentityContext(result: AuditRunInspectResult) {
  if (result.identity.state !== "present") {
    throw new Error(
      `identity inspection was ${result.identity.state}: ${result.identity.reasonCode}`,
    );
  }
  return result.identity.context;
}

function normalizedContextJson(result: AuditRunInspectResult) {
  return JSON.stringify(requireIdentityContext(result));
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function assertTextProjection(text: string) {
  for (const label of [...TEXT_SECTIONS, ...IDENTITY_FIELDS]) {
    if (!text.includes(label)) {
      throw new Error(`audit text projection omitted ${label}`);
    }
  }
  if (!text.includes("run_admission_identity_not_evaluated") || !text.includes("not-applicable")) {
    throw new Error("audit text projection overstated or omitted the admission decision");
  }
}

function assertJsonProjection(result: AuditRunInspectResult, runId: string) {
  const context = requireIdentityContext(result);
  if (result.run.runId !== runId || result.coverage.state !== context.coverageState) {
    throw new Error(`audit JSON projection did not preserve exact-run coverage: ${runId}`);
  }
  if (
    context.ingress.kind !== "local-cli" ||
    context.ingress.state !== "present" ||
    context.ingress.boundary !== "agent-command.local"
  ) {
    throw new Error("local agent run did not retain authoritative local-CLI ingress");
  }
  const admission = result.decisions.find(
    (receipt) => receipt.action.family === "run" && receipt.action.operation === "admission",
  );
  if (
    !admission ||
    admission.decision.outcome !== "not-applicable" ||
    admission.decision.reasonCode !== "run_admission_identity_not_evaluated"
  ) {
    throw new Error("audit JSON projection omitted the truthful admission receipt");
  }
}

function findLocalRunId(gateway: Awaited<ReturnType<typeof startQaGatewayChild>>) {
  const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("QA Gateway did not expose its isolated state directory");
  }
  const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    const rows = database
      .prepare("SELECT run_id FROM execution_identity_contexts ORDER BY created_at, context_id")
      .all() as Array<{ run_id: string }>;
    if (rows.length !== 1 || !rows[0]?.run_id) {
      throw new Error(`local run recorded ${String(rows.length)} execution identity contexts`);
    }
    return rows[0].run_id;
  } finally {
    database.close();
  }
}

async function runProof(options: ProducerOptions): Promise<string> {
  const mock = await startQaMockOpenAiServer();
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  try {
    gateway = await startQaGatewayChild({
      repoRoot: options.repoRoot,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
    });
    await gateway.runCli([
      "agent",
      "--local",
      "--agent",
      "qa",
      "--session-id",
      `identity-${randomUUID()}`,
      "--message",
      "Reply exactly: IDENTITY-INSPECTION-OK",
      "--thinking",
      "off",
      "--timeout",
      "60",
      "--json",
    ]);
    const runId = findLocalRunId(gateway);
    const beforeText = await gateway.runCli(["audit", "--run", runId, "--explain"]);
    assertTextProjection(beforeText);
    const before = parseJson<AuditRunInspectResult>(
      await gateway.runCli(["audit", "--run", runId, "--explain", "--json"]),
      "pre-restart audit inspection",
    );
    assertJsonProjection(before, runId);
    const beforeContext = normalizedContextJson(before);

    await gateway.restartAfterStateMutation(async () => {});

    const afterText = await gateway.runCli(["audit", "--run", runId, "--explain"]);
    assertTextProjection(afterText);
    const after = parseJson<AuditRunInspectResult>(
      await gateway.runCli(["audit", "--run", runId, "--explain", "--json"]),
      "post-restart audit inspection",
    );
    assertJsonProjection(after, runId);
    const afterContext = normalizedContextJson(after);
    if (afterContext !== beforeContext) {
      throw new Error("normalized execution identity context bytes changed across Gateway restart");
    }

    const snapshotPath = path.join(options.artifactBase, SNAPSHOT_FILE);
    await fs.mkdir(options.artifactBase, { recursive: true });
    await fs.writeFile(
      snapshotPath,
      `${JSON.stringify(
        {
          runId,
          coverage: before.coverage,
          decision: before.decisions[0]?.decision,
          contextSha256: sha256(beforeContext),
          byteEquivalentAfterRestart: true,
          textSections: TEXT_SECTIONS,
          identityFields: IDENTITY_FIELDS,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return `local run=${runId}; Gateway pid=${gateway.pid ?? "unknown"}; text+JSON passed before/after replacement; normalized context sha256=${sha256(beforeContext)}`;
  } finally {
    await gateway?.stop().catch(() => undefined);
    await mock.stop();
  }
}

async function produceProof(options: ProducerOptions): Promise<ProofResult> {
  const startedAt = Date.now();
  try {
    const details = await runProof(options);
    return {
      artifacts: [{ filePath: SNAPSHOT_FILE, kind: "summary" }],
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    };
  } catch (error) {
    return {
      details: formatErrorMessage(error),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    };
  }
}

async function runProducer(options: ProducerOptions): Promise<QaEvidenceSummaryJson> {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Agent-run execution identity inspection",
      sourcePath: `qa/scenarios/runtime/${SCENARIO_ID}.yaml`,
      docsRefs: ["docs/gateway/audit.md", "docs/cli/audit.md"],
      codeRefs: [
        "src/agents/agent-command.ts",
        "src/audit/execution-identity-admission.ts",
        "src/audit/audit-event-writer.ts",
        "src/audit/execution-identity-context.ts",
        "src/gateway/server-methods/audit.ts",
        "src/commands/audit.ts",
      ],
    },
  });
  const result = await produceProof(options);
  writer.appendLog(`${result.status}: ${result.details ?? "no details"}\n`);
  return await writer.write(result);
}

async function main(argv: readonly string[]) {
  const evidence = await runProducer(parseOptions(argv));
  const status = evidence.entries[0]?.result.status;
  console.log(`Agent-run identity evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Agent-run identity status: ${status}`);
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
