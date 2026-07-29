import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRepoRootRelativeRef, toRepoRelativePath } from "./cli-paths.js";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";

export async function readJsonFileIfExists(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON in ${filePath}: ${formatErrorMessage(error)}`, { cause: error });
  }
}

// Producer artifact paths resolve against their evidence bundle. External
// artifacts remain absolute so consumers never receive traversal segments.
function resolveScriptProducerArtifactPath(params: {
  evidenceDir: string;
  repoRoot: string;
  artifactPath: string;
}) {
  const absolutePath = path.isAbsolute(params.artifactPath)
    ? params.artifactPath
    : path.join(params.evidenceDir, params.artifactPath);
  const repoRelativePath = toRepoRelativePath(params.repoRoot, absolutePath);
  return isRepoRootRelativeRef(repoRelativePath) ? repoRelativePath : path.normalize(absolutePath);
}

function normalizeScriptProducerEvidence(params: {
  evidence: QaEvidenceSummaryJson;
  evidencePath: string;
  repoRoot: string;
}): QaEvidenceSummaryJson {
  const evidenceDir = path.dirname(params.evidencePath);
  return {
    ...params.evidence,
    entries: params.evidence.entries.map((entry) => ({
      ...entry,
      execution: entry.execution
        ? {
            ...entry.execution,
            artifacts: entry.execution.artifacts.map((artifact) => ({
              ...artifact,
              path: resolveScriptProducerArtifactPath({
                artifactPath: artifact.path,
                evidenceDir,
                repoRoot: params.repoRoot,
              }),
            })),
          }
        : undefined,
    })),
  };
}

export async function readScriptProducerEvidence(params: {
  outputDir: string;
  requireCurrentRunEvidence?: boolean;
  repoRoot: string;
  scenario: { id: string };
}): Promise<{ producerEvidence?: QaEvidenceSummaryJson }> {
  const scenarioOutputDir = path.join(params.outputDir, params.scenario.id);
  const latestRun = await readJsonFileIfExists(path.join(scenarioOutputDir, "latest-run.json"));
  if (params.requireCurrentRunEvidence === true) {
    if (latestRun === undefined) {
      return {};
    }
    if (
      latestRun === null ||
      typeof latestRun !== "object" ||
      !("qaEvidence" in latestRun) ||
      latestRun.qaEvidence !== QA_EVIDENCE_FILENAME
    ) {
      throw new Error(`latest-run.json must reference ${QA_EVIDENCE_FILENAME}`);
    }
    const evidencePath = path.join(scenarioOutputDir, QA_EVIDENCE_FILENAME);
    const rawEvidence = await readJsonFileIfExists(evidencePath);
    if (rawEvidence === undefined) {
      return {};
    }
    return {
      producerEvidence: normalizeScriptProducerEvidence({
        evidence: validateQaEvidenceSummaryJson(rawEvidence),
        evidencePath,
        repoRoot: params.repoRoot,
      }),
    };
  }
  const latestEvidencePath =
    latestRun !== null &&
    typeof latestRun === "object" &&
    "qaEvidence" in latestRun &&
    typeof latestRun.qaEvidence === "string"
      ? latestRun.qaEvidence
      : undefined;
  const candidates = [
    latestEvidencePath,
    path.join(scenarioOutputDir, QA_EVIDENCE_FILENAME),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const evidencePath = path.isAbsolute(candidate)
      ? candidate
      : path.join(scenarioOutputDir, candidate);
    const rawEvidence = await readJsonFileIfExists(evidencePath);
    if (!rawEvidence) {
      continue;
    }
    const evidence = validateQaEvidenceSummaryJson(rawEvidence);
    return {
      producerEvidence: normalizeScriptProducerEvidence({
        evidence,
        evidencePath,
        repoRoot: params.repoRoot,
      }),
    };
  }
  return {};
}
