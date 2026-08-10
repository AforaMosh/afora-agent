#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

type DependencyEvidenceReport = {
  name: string;
  command: string;
  policy: string;
  json: string;
  markdown: string;
};

type DependencyEvidenceCounts = {
  vulnerabilityBlockers: unknown;
  vulnerabilityFindings: unknown;
  transitiveRiskSignals: unknown;
  workspaceExcludedTransitiveSignals: unknown;
  transitiveMetadataFailures: unknown;
  ownershipLockfilePackages: unknown;
  ownershipBuildRiskPackages: unknown;
  dependencyFileChanges: unknown;
  dependencyAddedPackages: unknown;
  dependencyRemovedPackages: unknown;
  dependencyChangedPackages: unknown;
};

type LegacyModule = {
  DEPENDENCY_EVIDENCE_REPORTS: DependencyEvidenceReport[];
  resolveReleaseTag: (options: { releaseRef: unknown; packageVersion: unknown }) => unknown;
  resolvePreviousReleaseTag: (options?: {
    rootDir?: string;
    execFileSyncImpl?: (command: string, args?: string[]) => string;
    fetchOnMiss?: boolean;
  }) => string;
  createDependencyEvidenceManifest: (options?: {
    generatedAt?: string;
    releaseTag?: string;
    releaseRef?: string;
    releaseSha?: string;
    npmDistTag?: string;
    packageVersion?: string;
    workflowRunId?: string;
    workflowRunAttempt?: string;
    dependencyChangeBaseRef?: string;
  }) => {
    schemaVersion: number;
    generatedAt: string;
    releaseTag: unknown;
    releaseRef: unknown;
    releaseSha: unknown;
    npmDistTag: unknown;
    packageName: string;
    packageVersion: unknown;
    workflowRunId: string;
    workflowRunAttempt: string;
    dependencyChangeBaseRef: unknown;
    reports: DependencyEvidenceReport[];
  };
  collectDependencyEvidenceSummaryCounts: (
    evidenceDir: unknown,
  ) => Promise<DependencyEvidenceCounts>;
  renderDependencyEvidenceSummary: (options: {
    releaseTag: unknown;
    releaseSha: unknown;
    baseRef: unknown;
    counts: unknown;
  }) => string;
  renderDependencyEvidenceStepSummary: (options: {
    evidenceArtifactName: unknown;
    baseRef: unknown;
    counts: unknown;
  }) => string;
  parseArgs: (argv: string[]) => {
    help?: true;
    rootDir: string;
    outputDir: string | null;
    releaseRef: string | null;
    npmDistTag: string | null;
    baseRef: string | null;
    githubOutput: string | undefined;
    githubStepSummary: string | undefined;
  };
  main: (argv?: string[]) => Promise<number>;
};

const legacyModulePath: string = "./generate-dependency-release-evidence.mjs";
const legacy = (await import(legacyModulePath)) as LegacyModule;

export const {
  DEPENDENCY_EVIDENCE_REPORTS,
  collectDependencyEvidenceSummaryCounts,
  createDependencyEvidenceManifest,
  main,
  parseArgs,
  renderDependencyEvidenceStepSummary,
  renderDependencyEvidenceSummary,
  resolvePreviousReleaseTag,
  resolveReleaseTag,
} = legacy;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
