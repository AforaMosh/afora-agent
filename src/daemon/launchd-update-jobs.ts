/** Discovery and shutdown of stale Afora launchd updater jobs. */
import path from "node:path";
import {
  parseStrictInteger,
  parseStrictPositiveInteger,
} from "@afora/normalization-core/number-coercion";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  resolveGatewayLaunchAgentLabel,
} from "./constants.js";
import { isCurrentProcessLaunchdServiceLabel } from "./launchd-current-service.js";
import { execLaunchctl } from "./launchd-exec.js";
import { assertValidLaunchAgentLabel } from "./launchd-label.js";
import { readLaunchAgentProgramArgumentsFromFile } from "./launchd-plist.js";
import { resolveLaunchAgentGuiDomain } from "./launchd-runtime.js";
import { resolveLaunchAgentPlistPathForLabel } from "./launchd-service-files.js";

const AFORA_UPDATE_LAUNCHD_LABEL_PREFIX = "ai.afora.update.";
const AFORA_MANUAL_UPDATE_LAUNCHD_LABEL_PATTERN = /^ai\.afora\.manual-update\.\d+$/;
const AFORA_PROFILE_UPDATE_LAUNCHD_LABEL_PATTERN =
  /^ai\.afora\.[A-Za-z0-9._-]+\.update\.[A-Za-z0-9._-]+$/;
const AFORA_DIRECT_CLI_NAMES = new Set(["afora", "afora.mjs"]);
const AFORA_NODE_RUNTIME_NAMES = new Set(["bun", "bun.exe", "node", "node.exe"]);
const AFORA_SCRIPT_NAMES = new Set(["afora.mjs"]);
export type StaleAforaUpdateLaunchdJob = {
  label: string;
  pid?: number;
  lastExitStatus?: number;
};

type AforaUpdateLaunchdLabelCandidate = {
  label: string;
  requiresMetadata: boolean;
};

function normalizeAforaUpdateLaunchdLabel(label: unknown): string | null {
  if (typeof label !== "string") {
    return null;
  }
  const trimmed = label.trim();
  if (trimmed.startsWith(AFORA_UPDATE_LAUNCHD_LABEL_PREFIX)) {
    return trimmed;
  }
  // Manual update jobs include a timestamp-like suffix and should be cleaned up
  // without matching arbitrary ai.afora labels.
  return AFORA_MANUAL_UPDATE_LAUNCHD_LABEL_PATTERN.test(trimmed) ? trimmed : null;
}

function normalizeAforaUpdateLaunchdLabelCandidate(
  label: unknown,
): AforaUpdateLaunchdLabelCandidate | null {
  const normalized = normalizeAforaUpdateLaunchdLabel(label);
  if (normalized) {
    return { label: normalized, requiresMetadata: false };
  }
  if (typeof label !== "string") {
    return null;
  }
  const trimmed = label.trim();
  return AFORA_PROFILE_UPDATE_LAUNCHD_LABEL_PATTERN.test(trimmed)
    ? { label: trimmed, requiresMetadata: true }
    : null;
}

function isCurrentGatewayLaunchdLabel(label: string, env: NodeJS.ProcessEnv): boolean {
  const gatewayProfileLabel = resolveGatewayLaunchAgentLabel(env.AFORA_PROFILE);
  if (label === gatewayProfileLabel) {
    return true;
  }
  if (
    env.AFORA_SERVICE_MARKER?.trim() !== GATEWAY_SERVICE_MARKER ||
    env.AFORA_SERVICE_KIND?.trim() !== GATEWAY_SERVICE_KIND
  ) {
    return false;
  }
  const configuredLabel = env.AFORA_LAUNCHD_LABEL?.trim();
  return Boolean(configuredLabel && label === configuredLabel);
}

function resolveCurrentAforaUpdateLaunchdJobLabel(
  env: NodeJS.ProcessEnv = process.env,
): AforaUpdateLaunchdLabelCandidate | null {
  for (const label of [
    env.LAUNCH_JOB_LABEL,
    env.LAUNCH_JOB_NAME,
    env.XPC_SERVICE_NAME,
    env.AFORA_LAUNCHD_LABEL,
  ]) {
    const candidate = normalizeAforaUpdateLaunchdLabelCandidate(label);
    if (candidate) {
      if (isCurrentGatewayLaunchdLabel(candidate.label, env)) {
        continue;
      }
      return candidate;
    }
  }
  return null;
}

export function parseLaunchctlListAforaUpdateJobs(
  output: string,
): StaleAforaUpdateLaunchdJob[] {
  return parseLaunchctlListAforaUpdateJobCandidates(output)
    .filter((job) => !job.requiresMetadata)
    .map(({ requiresMetadata: _requiresMetadata, ...job }) => job);
}

function parseLaunchctlListAforaUpdateJobCandidates(
  output: string,
): Array<StaleAforaUpdateLaunchdJob & AforaUpdateLaunchdLabelCandidate> {
  const jobs: Array<StaleAforaUpdateLaunchdJob & AforaUpdateLaunchdLabelCandidate> = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/);
    const [pidRaw, statusRaw, ...labelParts] = parts;
    const candidate = normalizeAforaUpdateLaunchdLabelCandidate(labelParts.join(" "));
    if (!candidate) {
      continue;
    }
    const pid = pidRaw === "-" ? undefined : parseStrictPositiveInteger(pidRaw ?? "");
    const lastExitStatus = parseStrictInteger(statusRaw ?? "");
    jobs.push({
      label: candidate.label,
      requiresMetadata: candidate.requiresMetadata,
      ...(pid !== undefined ? { pid } : {}),
      ...(lastExitStatus !== undefined ? { lastExitStatus } : {}),
    });
  }
  return jobs.toSorted((a, b) => a.label.localeCompare(b.label));
}

function hasAforaUpdateLaunchdMarker(env: Record<string, string | undefined> | undefined) {
  return env?.AFORA_UPDATE_RUN_HANDOFF?.trim() === "1";
}

function isAforaUpdateCommandPrefix(programArguments: string[], updateIndex: number): boolean {
  if (updateIndex === 1) {
    const cliName = path.basename(programArguments[0] ?? "").toLowerCase();
    return AFORA_DIRECT_CLI_NAMES.has(cliName);
  }
  if (updateIndex !== 2) {
    return false;
  }
  const runtimeName = path.basename(programArguments[0] ?? "").toLowerCase();
  const entryName = path.basename(programArguments[1] ?? "").toLowerCase();
  return AFORA_NODE_RUNTIME_NAMES.has(runtimeName) && AFORA_SCRIPT_NAMES.has(entryName);
}

function isAforaUpdateProgramArguments(programArguments: string[] | undefined): boolean {
  if (!Array.isArray(programArguments) || programArguments.length === 0) {
    return false;
  }
  const updateIndex = programArguments.findIndex((arg) => arg.trim() === "update");
  if (updateIndex < 0 || !programArguments.slice(updateIndex + 1).includes("--yes")) {
    return false;
  }
  return (
    isAforaUpdateCommandPrefix(programArguments, updateIndex) &&
    !programArguments.some((arg) => arg.trim() === "gateway")
  );
}

async function isLaunchdJobConfirmedAforaUpdater(params: {
  label: string;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const plistPath = resolveLaunchAgentPlistPathForLabel(params.env, params.label);
  const command = await readLaunchAgentProgramArgumentsFromFile(plistPath);
  return (
    hasAforaUpdateLaunchdMarker(command?.environment) ||
    isAforaUpdateProgramArguments(command?.programArguments)
  );
}

export async function findStaleAforaUpdateLaunchdJobs(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StaleAforaUpdateLaunchdJob[]> {
  if (process.platform !== "darwin") {
    return [];
  }
  const result = await execLaunchctl(["list"]);
  if (result.code !== 0) {
    return [];
  }
  // Never report the active gateway label as stale even when a wrapper exposes
  // update-like launchd metadata through the current environment.
  const jobs: StaleAforaUpdateLaunchdJob[] = [];
  for (const job of parseLaunchctlListAforaUpdateJobCandidates(result.stdout)) {
    if (isCurrentGatewayLaunchdLabel(job.label, env)) {
      continue;
    }
    if (
      job.requiresMetadata &&
      !(await isLaunchdJobConfirmedAforaUpdater({ label: job.label, env }))
    ) {
      continue;
    }
    jobs.push({
      label: job.label,
      ...(job.pid !== undefined ? { pid: job.pid } : {}),
      ...(job.lastExitStatus !== undefined ? { lastExitStatus: job.lastExitStatus } : {}),
    });
  }
  return jobs;
}

async function disableAforaUpdateLaunchdJobCandidate(params: {
  candidate: AforaUpdateLaunchdLabelCandidate;
  env: NodeJS.ProcessEnv;
  trustCurrentEnvMarker: boolean;
}): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  if (
    params.candidate.requiresMetadata &&
    !(
      (params.trustCurrentEnvMarker && hasAforaUpdateLaunchdMarker(params.env)) ||
      (await isLaunchdJobConfirmedAforaUpdater({
        label: params.candidate.label,
        env: params.env,
      }))
    )
  ) {
    return false;
  }
  const serviceTarget = `${resolveLaunchAgentGuiDomain()}/${assertValidLaunchAgentLabel(params.candidate.label)}`;
  const result = await execLaunchctl(["disable", serviceTarget]);
  return result.code === 0;
}

export async function disableAforaUpdateLaunchdJob(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const candidate = normalizeAforaUpdateLaunchdLabelCandidate(label);
  if (!candidate) {
    return false;
  }
  return await disableAforaUpdateLaunchdJobCandidate({
    candidate,
    env,
    trustCurrentEnvMarker: false,
  });
}

export async function disableCurrentAforaUpdateLaunchdJob(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const candidate = resolveCurrentAforaUpdateLaunchdJobLabel(env);
  if (!candidate) {
    return false;
  }
  return await disableAforaUpdateLaunchdJobCandidate({
    candidate,
    env,
    // Detached handoffs preserve the configured label, so only launchd-backed
    // current-process identity may turn the ambient marker into proof.
    trustCurrentEnvMarker: isCurrentProcessLaunchdServiceLabel(candidate.label, env, {
      allowConfiguredLabelFallback: false,
    }),
  });
}
