import type { ChildProcess } from "node:child_process";
import type { RespawnChildRuntime } from "./process/respawn-child-runner.js";
import "./entry.compile-cache.js";

type CompileCacheParams = {
  env?: NodeJS.ProcessEnv;
  installRoot: string;
};

type CompileCacheRespawnPlan = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  detachForProcessTree: boolean;
};

type CompileCacheTestApi = {
  buildAforaCompileCacheRespawnPlan(params: {
    currentFile: string;
    env?: NodeJS.ProcessEnv;
    execArgv?: string[];
    execPath?: string;
    installRoot: string;
    argv?: string[];
    compileCacheDir?: string;
    platform?: NodeJS.Platform;
  }): CompileCacheRespawnPlan | undefined;
  isSourceCheckoutInstallRoot(installRoot: string): boolean;
  resolveAforaCompileCacheDirectory(params: {
    env?: NodeJS.ProcessEnv;
    installRoot: string;
  }): string;
  runAforaCompileCacheRespawnPlan(
    plan: CompileCacheRespawnPlan,
    runtime?: RespawnChildRuntime & { writeError(message: string): void },
  ): ChildProcess;
  shouldEnableAforaCompileCache(params: CompileCacheParams): boolean;
};

function getTestApi(): CompileCacheTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("afora.entryCompileCacheTestApi")
  ] as CompileCacheTestApi;
}

export function buildAforaCompileCacheRespawnPlan(
  params: Parameters<CompileCacheTestApi["buildAforaCompileCacheRespawnPlan"]>[0],
): CompileCacheRespawnPlan | undefined {
  return getTestApi().buildAforaCompileCacheRespawnPlan(params);
}

export function isSourceCheckoutInstallRoot(installRoot: string): boolean {
  return getTestApi().isSourceCheckoutInstallRoot(installRoot);
}

export function resolveAforaCompileCacheDirectory(
  params: Parameters<CompileCacheTestApi["resolveAforaCompileCacheDirectory"]>[0],
): string {
  return getTestApi().resolveAforaCompileCacheDirectory(params);
}

export function runAforaCompileCacheRespawnPlan(
  ...args: Parameters<CompileCacheTestApi["runAforaCompileCacheRespawnPlan"]>
): ChildProcess {
  return getTestApi().runAforaCompileCacheRespawnPlan(...args);
}

export function shouldEnableAforaCompileCache(params: CompileCacheParams): boolean {
  return getTestApi().shouldEnableAforaCompileCache(params);
}
