import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveUserPath } from "afora-agent/plugin-sdk/account-resolution";
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import { isRecord } from "afora-agent/plugin-sdk/string-coerce-runtime";

export const REEF_DURABLE_LEGACY_FILENAMES = [
  "keys.json",
  "identity.json",
  "setup-session.json",
  "audit.jsonl",
  "replay.jsonl",
  "reviews.json",
  "delivered.json",
] as const;

export function resolveLegacyReefStateDir(params: {
  config: AforaConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  homeDir?: string;
}): string {
  const reef = params.config.channels?.reef;
  const configured = isRecord(reef) && typeof reef.stateDir === "string" ? reef.stateDir : null;
  const defaultDir = resolveDefaultLegacyReefStateDir(params.homeDir);
  const configuredDir = configured ? resolveUserPath(configured, params.env) : null;
  if (configuredDir) {
    return configuredDir;
  }
  const relativeToActiveState = path.relative(path.resolve(params.stateDir), defaultDir);
  return relativeToActiveState === "" ||
    (!relativeToActiveState.startsWith(`..${path.sep}`) &&
      relativeToActiveState !== ".." &&
      !path.isAbsolute(relativeToActiveState))
    ? defaultDir
    : path.join(params.stateDir, "data", "reef");
}

function resolveDefaultLegacyReefStateDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".afora", "data", "reef");
}

export async function legacyReefFileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}
