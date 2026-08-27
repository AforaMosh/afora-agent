// Test Env Mutation Report tests cover test env mutation report script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectTestEnvMutationReport,
  main as runTestEnvMutationReport,
  renderTestEnvMutationReport,
  type TestEnvMutationReport,
} from "../../scripts/test-env-mutation-report.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function writeRepoFile(repoRoot: string, relativePath: string, value: string): void {
  const filePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function makeEnvMutationFixture(): string {
  const repoRoot = createTempDir("afora-test-env-mutations-");
  writeRepoFile(
    repoRoot,
    "src/runtime.ts",
    `
process.env.AFORA_STATE_DIR = "ignored because this is not a test file";
`,
  );
  writeRepoFile(
    repoRoot,
    "src/example.test.ts",
    `
process.env.AFORA_STATE_DIR = "state";
delete process.env["AFORA_CONFIG_PATH"];
vi.stubEnv("HOME", "home");
vi.stubEnv("AFORA_WORKSPACE_DIR", "workspace");
process.env = { ...process.env, AFORA_HOME: "home", OTHER_KEY: "ignored" };
const dynamicEnvKey = "AFORA_STATE_DIR";
process.env[dynamicEnvKey] = "dynamic";
delete process.env[dynamicEnvKey];
const fixture = 'process.env.AFORA_HOME = "not code"';
process.env.NOT_AFORA = "ignored";
`,
  );
  writeRepoFile(
    repoRoot,
    "scripts/mcp-code-mode-gateway-e2e.ts",
    `
process.env.AFORA_CONFIG_PATH = "script-harness";
`,
  );
  writeRepoFile(
    repoRoot,
    "src/agents/auth-profiles/oauth-test-utils.ts",
    `
process.env.AFORA_AGENT_DIR = "agent";
`,
  );
  writeRepoFile(
    repoRoot,
    "src/test-utils/afora-test-state.ts",
    `
process.env.HOME = "allowed";
delete process.env.AFORA_STATE_DIR;
`,
  );
  return repoRoot;
}

describe("collectTestEnvMutationReport", () => {
  it("reports active Afora env mutations while ignoring strings and non-test files", () => {
    const report = collectTestEnvMutationReport({ repoRoot: makeEnvMutationFixture() });

    expect(
      report.activeFindings.map((finding) => ({
        file: finding.file,
        key: finding.key,
        operation: finding.operation,
      })),
    ).toEqual([
      {
        file: "scripts/mcp-code-mode-gateway-e2e.ts",
        key: "AFORA_CONFIG_PATH",
        operation: "assign",
      },
      {
        file: "src/agents/auth-profiles/oauth-test-utils.ts",
        key: "AFORA_AGENT_DIR",
        operation: "assign",
      },
      { file: "src/example.test.ts", key: "AFORA_STATE_DIR", operation: "assign" },
      { file: "src/example.test.ts", key: "AFORA_CONFIG_PATH", operation: "delete" },
      { file: "src/example.test.ts", key: "HOME", operation: "stubEnv" },
      { file: "src/example.test.ts", key: "AFORA_WORKSPACE_DIR", operation: "stubEnv" },
      { file: "src/example.test.ts", key: "AFORA_HOME", operation: "replace" },
      { file: "src/example.test.ts", key: "<dynamic>", operation: "assign" },
      { file: "src/example.test.ts", key: "<dynamic>", operation: "delete" },
    ]);
    expect(report.allowedFindings).toHaveLength(2);
    expect(report.summary).toMatchObject({
      activeFileCount: 3,
      activeFindingCount: 9,
      allowedFileCount: 1,
      allowedFindingCount: 2,
    });
  });

  it("renders a non-blocking text report for active findings", () => {
    const report = collectTestEnvMutationReport({ repoRoot: makeEnvMutationFixture() });

    const rendered = renderTestEnvMutationReport(report, { includeAllowed: true });

    expect(rendered).toContain("Afora test env mutation report");
    expect(rendered).toContain("Findings: 9 active in 3 file(s), 2 allowed in 1 file(s)");
    expect(rendered).toContain("- src/example.test.ts (7)");
    expect(rendered).toContain("L2 AFORA_STATE_DIR assign process.env");
    expect(rendered).toContain("Allowed harness findings:");
  });

  it("prints JSON from the CLI and exits successfully", () => {
    const repoRoot = makeEnvMutationFixture();
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(process.cwd(), "scripts/test-env-mutation-report.ts"),
        "--",
        "--repo-root",
        repoRoot,
        "--json",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as TestEnvMutationReport;
    expect(report.summary.activeFindingCount).toBe(9);
    expect(report.summary.allowedFindingCount).toBe(2);
  });

  it("prints CLI help without scanning the repository", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(process.cwd(), "scripts/test-env-mutation-report.ts"),
        "--help",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("pnpm test:env-mutations:report");
    expect(result.stdout).not.toContain("Scanned files:");
    expect(result.stderr).toBe("");
  });

  it("rejects missing or flag-shaped CLI repo roots instead of scanning zero files", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(process.cwd(), "scripts/test-env-mutation-report.ts"),
        "--",
        "--repo-root",
        "--json",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--repo-root expects a path");
    expect(() => runTestEnvMutationReport(["--", "--repo-root", "-h"])).toThrow(
      "--repo-root expects a path",
    );
  });

  it("rejects loose CLI limits before scanning the repository", () => {
    for (const limit of ["1e3", ""]) {
      expect(() =>
        runTestEnvMutationReport([
          "--",
          "--limit",
          limit,
          "--repo-root",
          createTempDir("afora-env-limit-"),
        ]),
      ).toThrow("--limit expects a non-negative integer");
    }
  });
});
