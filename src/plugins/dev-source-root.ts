// Resolves development source roots for local plugin installs.
import fs from "node:fs";
import path from "node:path";
import { isCorePackageName } from "../infra/core-package-names.js";
import { resolveUserPath } from "../utils.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";

/** Env var that points bundled-plugin lookup at an Afora source checkout. */
const AFORA_DEV_SOURCE_ROOT_ENV = "AFORA_DEV_SOURCE_ROOT";

function readPackageName(packageJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

/** Resolves and validates the configured Afora development source root. */
export function resolveAforaDevSourceRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const rawRoot = env[AFORA_DEV_SOURCE_ROOT_ENV]?.trim();
  if (!rawRoot) {
    return null;
  }
  const resolvedRoot = resolveUserPath(rawRoot, env);
  const realRoot = safeRealpathSync(resolvedRoot);
  if (!realRoot) {
    return null;
  }
  // The two checks below require src/ and extensions/, so this is validating a source checkout,
  // and a source checkout's manifest name is "afora-agent" rather than the published "afora".
  // Pinning one name made the check reject the only tree it can be pointed at.
  if (!isCorePackageName(readPackageName(path.join(realRoot, "package.json")))) {
    return null;
  }
  if (!fs.existsSync(path.join(realRoot, "src"))) {
    return null;
  }
  if (!fs.existsSync(path.join(realRoot, "extensions"))) {
    return null;
  }
  return realRoot;
}

/** True when a bundled plugin root is inside the configured development source root. */
export function isBundledPluginInsideDevSourceRoot(params: {
  rootDir: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  const devSourceRoot = resolveAforaDevSourceRoot(params.env);
  if (!devSourceRoot) {
    return false;
  }
  const extensionsRoot = safeRealpathSync(path.join(devSourceRoot, "extensions"));
  const pluginRoot = safeRealpathSync(resolveUserPath(params.rootDir, params.env));
  if (!extensionsRoot || !pluginRoot) {
    return false;
  }
  return isPathInside(extensionsRoot, pluginRoot);
}
