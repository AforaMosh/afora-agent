// Bench memory authorization shadow tests cover the deterministic evidence contract.
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/bench-memory-authorization-shadow.ts";

type BenchmarkReport = {
  fixture: {
    digest: string;
    inputDigest: string;
    resultDigest: string;
  };
  gitSha: string;
  node: string;
  platform: {
    arch: string;
    osRelease: string;
    platform: string;
  };
  parity: {
    bridgeInputDigest: string;
    bridgeResultDigest: string;
    directInputDigest: string;
    directResultDigest: string;
    inputDigestsMatchFixture: boolean;
    resultDigestsMatchFixture: boolean;
  };
  rssBytes: number;
  rssMb: number;
  shadowInspection: string;
  timingsMs: {
    bridge: { p50Ms: number; p95Ms: number; runs: number };
    direct: { p50Ms: number; p95Ms: number; runs: number };
  };
};

function runBenchmark(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
    },
  });
}

describe("memory authorization shadow benchmark", () => {
  it("records fixture parity and portable runtime evidence without a timing gate", () => {
    const result = runBenchmark("--", "--runs", "2", "--warmup", "1", "--json");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as BenchmarkReport;
    const gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();

    expect(report.gitSha).toBe(gitSha);
    expect(report.node).toBe(process.version);
    expect(report.platform).toMatchObject({
      arch: process.arch,
      platform: process.platform,
    });
    expect(report.shadowInspection).toBe("prewarmed-once");
    expect(report.fixture).toEqual({
      digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      resultDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(report.parity).toMatchObject({
      bridgeInputDigest: report.fixture.inputDigest,
      bridgeResultDigest: report.fixture.resultDigest,
      directInputDigest: report.fixture.inputDigest,
      directResultDigest: report.fixture.resultDigest,
      inputDigestsMatchFixture: true,
      resultDigestsMatchFixture: true,
    });
    expect(report.rssBytes).toEqual(expect.any(Number));
    expect(report.rssMb).toEqual(expect.any(Number));
    for (const timing of Object.values(report.timingsMs)) {
      expect(timing.runs).toBe(2);
      expect(Number.isFinite(timing.p50Ms)).toBe(true);
      expect(Number.isFinite(timing.p95Ms)).toBe(true);
    }
  });

  it("rejects invalid benchmark counts before running the fixture", () => {
    const result = runBenchmark("--runs", "0");

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--runs must be a positive integer");
    expect(result.stderr).not.toContain("\n    at ");
  });
});
