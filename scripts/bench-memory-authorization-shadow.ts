// Bench the steady-state memory runtime bridge against direct plugin acquisition.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { MemorySearchManager } from "../packages/memory-host-sdk/src/host/types.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { emitMemoryAuthorizationShadowSurfaceInspection } from "../src/plugins/memory-authorization-shadow.js";
import { getActiveMemorySearchManager } from "../src/plugins/memory-runtime.js";
import type { MemoryPluginRuntime } from "../src/plugins/registry-contribution-types.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../src/plugins/runtime/gateway-request-scope.js";
import { stripLeadingPackageManagerSeparator } from "./lib/arg-utils.mjs";

type AcquisitionParams = Parameters<MemoryPluginRuntime["getMemorySearchManager"]>[0];
type AcquisitionResult = Awaited<ReturnType<MemoryPluginRuntime["getMemorySearchManager"]>>;

type Options = {
  json: boolean;
  output?: string;
  runs: number;
  warmup: number;
};

type TimingSummary = {
  maxMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  runs: number;
};

type BenchmarkReport = {
  fixture: {
    digest: string;
    inputDigest: string;
    resultDigest: string;
  };
  gitSha: string;
  node: string;
  options: Omit<Options, "json">;
  platform: {
    arch: string;
    osRelease: string;
    platform: NodeJS.Platform;
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
  shadowInspection: "prewarmed-once";
  timingsMs: {
    bridge: TimingSummary;
    direct: TimingSummary;
  };
};

type Fixture = {
  captureObservedParams(): AcquisitionParams;
  manager: MemorySearchManager;
  params: AcquisitionParams;
  registry: ReturnType<typeof createEmptyPluginRegistry>;
  result: AcquisitionResult;
  runtime: MemoryPluginRuntime;
};

const DEFAULT_RUNS = 1_000;
const DEFAULT_WARMUP = 100;
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const VALUE_FLAGS = new Set(["--output", "--runs", "--warmup"]);
const BOOLEAN_FLAGS = new Set(["--json"]);

class CliArgumentError extends Error {
  override name = "CliArgumentError";
}

function parsePositiveInteger(flag: string, value: string | undefined): number {
  if (!/^\d+$/u.test(value ?? "")) {
    throw new CliArgumentError(`${flag} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliArgumentError(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(flag: string, value: string | undefined): number {
  if (!/^\d+$/u.test(value ?? "")) {
    throw new CliArgumentError(`${flag} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CliArgumentError(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptions(args = process.argv.slice(2)): Options {
  const normalizedArgs = stripLeadingPackageManagerSeparator(args);
  const seenFlags = new Set<string>();
  const options: Options = {
    json: false,
    runs: DEFAULT_RUNS,
    warmup: DEFAULT_WARMUP,
  };
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index] ?? "";
    if (!VALUE_FLAGS.has(arg) && !BOOLEAN_FLAGS.has(arg)) {
      throw new CliArgumentError(`Unknown argument: ${arg}`);
    }
    if (seenFlags.has(arg)) {
      throw new CliArgumentError(`${arg} was provided more than once`);
    }
    seenFlags.add(arg);
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const value = normalizedArgs[index + 1];
    if (!value || value.startsWith("-")) {
      throw new CliArgumentError(`${arg} requires a value`);
    }
    index += 1;
    if (arg === "--runs") {
      options.runs = parsePositiveInteger(arg, value);
    } else if (arg === "--warmup") {
      options.warmup = parseNonNegativeInteger(arg, value);
    } else {
      options.output = value;
    }
  }
  return options;
}

function printUsage(): void {
  process.stdout.write(`OpenClaw memory authorization shadow benchmark

Usage:
  pnpm perf:memory-authorization-shadow -- [options]
  node --import tsx scripts/bench-memory-authorization-shadow.ts [options]

The benchmark uses a scoped fake memory registry. It compares direct plugin
acquisition with the shadow bridge after the bridge's one-time inspection.

Options:
  --runs <n>       Measured acquisitions per path (default: ${DEFAULT_RUNS})
  --warmup <n>     Warmup acquisitions per path (default: ${DEFAULT_WARMUP})
  --output <path>  Write the JSON evidence report
  --json           Print the JSON evidence report
  --help, -h       Show this text
`);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("benchmark fixture must be JSON-finite");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (entry === undefined ? null : canonicalize(entry)));
  }
  if (isRecord(value)) {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).toSorted()) {
      const entry = value[key];
      if (entry !== undefined) {
        normalized[key] = canonicalize(entry);
      }
    }
    return normalized;
  }
  throw new TypeError("benchmark fixture must be JSON-serializable");
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(values: number[], ratio: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio));
  return sorted[index] ?? 0;
}

function summarizeTimings(samples: number[]): TimingSummary {
  if (samples.length === 0) {
    throw new Error("benchmark requires at least one measured acquisition");
  }
  return {
    maxMs: round(Math.max(...samples)),
    minMs: round(Math.min(...samples)),
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    runs: samples.length,
  };
}

function describeInput(params: AcquisitionParams): Record<string, unknown> {
  return {
    agentId: params.agentId,
    cfg: params.cfg,
    purpose: params.purpose ?? null,
  };
}

function describeResult(result: AcquisitionResult, fixture: Fixture): Record<string, unknown> {
  return {
    debug: result.debug ?? null,
    error: result.error ?? null,
    manager:
      result.manager === fixture.manager
        ? "fixture-manager"
        : result.manager === null
          ? null
          : "unexpected-manager",
  };
}

function createFixture(): Fixture {
  let observedParams: AcquisitionParams | undefined;
  const manager: MemorySearchManager = {
    async search() {
      return [];
    },
    async readFile({ relPath }) {
      return { path: relPath, text: "fixture memory" };
    },
    status() {
      return { backend: "builtin", provider: "fixture" };
    },
    async probeEmbeddingAvailability() {
      return { cached: true, checked: true, ok: true };
    },
    async probeVectorAvailability() {
      return true;
    },
  };
  const debug = {
    backend: "builtin" as const,
    managerCacheState: "cached-full-hit" as const,
    managerMs: 0,
    purpose: "default" as const,
  };
  Object.freeze(debug);
  const result: AcquisitionResult = {
    debug,
    manager,
  };
  Object.freeze(result);
  const runtime = {
    async getMemorySearchManager(params: AcquisitionParams) {
      observedParams = params;
      return result;
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" as const };
    },
  } satisfies MemoryPluginRuntime;
  const registry = createEmptyPluginRegistry();
  registry.memoryCapabilities.push({
    capability: { runtime },
    pluginId: "memory-authorization-benchmark",
  });
  const params: AcquisitionParams = {
    agentId: "benchmark-agent",
    cfg: {
      plugins: Object.freeze({
        slots: Object.freeze({ memory: "memory-authorization-benchmark" }),
      }),
    } as OpenClawConfig,
    purpose: "default" as const,
  };
  Object.freeze(params);
  // Hot acquisition performs only the bounded WeakSet lookup. Running the
  // inspection once here keeps the comparison representative of production use.
  emitMemoryAuthorizationShadowSurfaceInspection(runtime, () => {});
  return {
    captureObservedParams() {
      if (!observedParams) {
        throw new Error("benchmark runtime did not receive acquisition parameters");
      }
      const captured = observedParams;
      observedParams = undefined;
      return captured;
    },
    manager,
    params,
    registry,
    result,
    runtime,
  };
}

async function inFixtureRegistry<T>(fixture: Fixture, run: () => Promise<T>): Promise<T> {
  return await withPluginRuntimeRegistryScope(fixture.registry, run);
}

async function acquireDirect(fixture: Fixture): Promise<AcquisitionResult> {
  return await inFixtureRegistry(
    fixture,
    async () => await fixture.runtime.getMemorySearchManager(fixture.params),
  );
}

async function acquireBridge(fixture: Fixture): Promise<AcquisitionResult> {
  return await inFixtureRegistry(
    fixture,
    async () => await getActiveMemorySearchManager(fixture.params),
  );
}

async function verifyParity(fixture: Fixture): Promise<BenchmarkReport["parity"]> {
  const fixtureInputDigest = digest(describeInput(fixture.params));
  const fixtureResultDigest = digest(describeResult(fixture.result, fixture));

  const directResult = await acquireDirect(fixture);
  const directParams = fixture.captureObservedParams();
  const bridgeResult = await acquireBridge(fixture);
  const bridgeParams = fixture.captureObservedParams();
  if (directParams !== fixture.params || bridgeParams !== fixture.params) {
    throw new Error("memory bridge changed the fixture acquisition parameters");
  }

  const directInputDigest = digest(describeInput(directParams));
  const bridgeInputDigest = digest(describeInput(bridgeParams));
  const directResultDigest = digest(describeResult(directResult, fixture));
  const bridgeResultDigest = digest(describeResult(bridgeResult, fixture));
  const inputDigestsMatchFixture =
    directInputDigest === fixtureInputDigest && bridgeInputDigest === fixtureInputDigest;
  const resultDigestsMatchFixture =
    directResultDigest === fixtureResultDigest && bridgeResultDigest === fixtureResultDigest;
  if (!inputDigestsMatchFixture || !resultDigestsMatchFixture) {
    throw new Error("memory bridge changed the benchmark fixture result");
  }
  return {
    bridgeInputDigest,
    bridgeResultDigest,
    directInputDigest,
    directResultDigest,
    inputDigestsMatchFixture,
    resultDigestsMatchFixture,
  };
}

async function measureAcquisitionPaths(
  fixture: Fixture,
  options: Options,
): Promise<BenchmarkReport["timingsMs"]> {
  const directSamples: number[] = [];
  const bridgeSamples: number[] = [];
  const measure = async (
    acquire: () => Promise<AcquisitionResult>,
    samples: number[],
  ): Promise<void> => {
    const started = performance.now();
    await acquire();
    samples.push(performance.now() - started);
  };

  for (let index = 0; index < options.warmup; index += 1) {
    await acquireDirect(fixture);
    await acquireBridge(fixture);
  }
  for (let index = 0; index < options.runs; index += 1) {
    // Alternate the first path so JIT and scheduler effects do not always favor one route.
    if (index % 2 === 0) {
      await measure(() => acquireDirect(fixture), directSamples);
      await measure(() => acquireBridge(fixture), bridgeSamples);
    } else {
      await measure(() => acquireBridge(fixture), bridgeSamples);
      await measure(() => acquireDirect(fixture), directSamples);
    }
  }
  return {
    bridge: summarizeTimings(bridgeSamples),
    direct: summarizeTimings(directSamples),
  };
}

function resolveExactGitSha(): string {
  const sha = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error("benchmark could not resolve an exact Git SHA");
  }
  return sha;
}

function printProofLines(report: BenchmarkReport): void {
  console.log(`MEMORY_AUTHORIZATION_SHADOW_BENCH_GIT_SHA=${report.gitSha}`);
  console.log(`MEMORY_AUTHORIZATION_SHADOW_BENCH_FIXTURE_DIGEST=${report.fixture.digest}`);
  console.log(
    `MEMORY_AUTHORIZATION_SHADOW_BENCH_PARITY input_matches_fixture=${report.parity.inputDigestsMatchFixture} result_matches_fixture=${report.parity.resultDigestsMatchFixture}`,
  );
  for (const [name, timing] of Object.entries(report.timingsMs)) {
    console.log(
      `MEMORY_AUTHORIZATION_SHADOW_BENCH_${name.toUpperCase()} p50_ms=${timing.p50Ms.toFixed(3)} p95_ms=${timing.p95Ms.toFixed(3)} runs=${timing.runs}`,
    );
  }
  console.log(
    `MEMORY_AUTHORIZATION_SHADOW_BENCH_RUNTIME node=${report.node} platform=${report.platform.platform}/${report.platform.arch} rss_mb=${report.rssMb.toFixed(3)}`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }
  const options = parseOptions(args);
  const fixture = createFixture();
  const fixtureInput = describeInput(fixture.params);
  const fixtureResult = describeResult(fixture.result, fixture);
  const parity = await verifyParity(fixture);
  const timingsMs = await measureAcquisitionPaths(fixture, options);
  const rssBytes = process.memoryUsage().rss;
  const report: BenchmarkReport = {
    fixture: {
      digest: digest({ input: fixtureInput, result: fixtureResult }),
      inputDigest: digest(fixtureInput),
      resultDigest: digest(fixtureResult),
    },
    gitSha: resolveExactGitSha(),
    node: process.version,
    options: {
      output: options.output,
      runs: options.runs,
      warmup: options.warmup,
    },
    platform: {
      arch: process.arch,
      osRelease: os.release(),
      platform: process.platform,
    },
    parity,
    rssBytes,
    rssMb: round(rssBytes / 1024 / 1024),
    shadowInspection: "prewarmed-once",
    timingsMs,
  };
  if (options.output) {
    await mkdir(path.dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printProofLines(report);
  }
}

main().catch((error: unknown) => {
  if (error instanceof CliArgumentError) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  throw error;
});
