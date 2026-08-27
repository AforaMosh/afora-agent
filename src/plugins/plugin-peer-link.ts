// Links plugin peer packages for local development installs.
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { hasErrnoCode } from "../infra/errors.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { readRootJsonObjectSync } from "../infra/json-files.js";
import { resolveAforaPackageRootSync } from "../infra/afora-root.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolvePluginInstallDir } from "./install-paths.js";

type PluginPeerLinkLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type RelinkManagedNpmRootResult = {
  checked: number;
  attempted: number;
  repaired: number;
  skipped: number;
};

export type AforaPeerLinkAuditIssue = {
  packageName: string;
  packageDir: string;
  reason: string;
};

type AuditManagedNpmRootResult = {
  checked: number;
  broken: number;
  issues: AforaPeerLinkAuditIssue[];
};

type AforaPeerLinkResult = "linked" | "skipped" | "unchanged";

type AforaHostDependency = {
  declaration: "peerDependencies" | "dependencies";
  spec: string;
};

type RegisteredAforaHostLinkResult = {
  checked: number;
  repaired: number;
  skipped: number;
  issues: AforaPeerLinkAuditIssue[];
};

/** Resolve the host declaration consistently for peer and direct runtime dependencies. */
export function resolveAforaHostDependency(manifest: {
  dependencies?: unknown;
  peerDependencies?: unknown;
}): AforaHostDependency | null {
  for (const declaration of ["peerDependencies", "dependencies"] as const) {
    const dependencies = manifest[declaration];
    const spec =
      typeof dependencies === "object" && dependencies !== null && !Array.isArray(dependencies)
        ? (dependencies as Record<string, unknown>).afora
        : undefined;
    if (typeof spec === "string" && spec) {
      return { declaration, spec };
    }
  }
  return null;
}

async function readSafePackageManifest(
  packageDir: string,
): Promise<Record<string, unknown> | null> {
  const result = readRootJsonObjectSync({
    rootDir: packageDir,
    relativePath: "package.json",
    boundaryLabel: "installed plugin package directory",
  });
  if (!result.ok) {
    if (
      result.reason === "open" &&
      (result.failure.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    ) {
      return null;
    }
    if (result.reason === "parse") {
      throw new SyntaxError(result.error);
    }
    if (result.reason === "open" && result.failure.error instanceof Error) {
      throw result.failure.error;
    }
    throw new Error(
      `Could not safely read package.json from ${packageDir}: ${
        result.reason === "open" ? result.failure.reason : result.error
      }`,
    );
  }
  return result.value;
}

async function readPackageAforaLinkDependencies(
  packageDir: string,
): Promise<Record<string, string>> {
  const manifest = await readSafePackageManifest(packageDir);
  const dependency = manifest ? resolveAforaHostDependency(manifest) : null;
  return dependency ? { afora: dependency.spec } : {};
}

async function listManagedNpmRootPackageDirs(npmRoot: string): Promise<string[]> {
  const nodeModulesDir = path.join(npmRoot, "node_modules");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(nodeModulesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const packageDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".bin") {
      continue;
    }
    const entryPath = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith("@")) {
      const scopedEntries = await fs
        .readdir(entryPath, { withFileTypes: true })
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
          }
          throw error;
        });
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.isDirectory()) {
          packageDirs.push(path.join(entryPath, scopedEntry.name));
        }
      }
      continue;
    }
    if (!entry.name.startsWith(".")) {
      packageDirs.push(entryPath);
    }
  }
  return packageDirs.toSorted((a, b) => a.localeCompare(b));
}

async function safeRealpath(filePath: string): Promise<string | null> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return null;
  }
}

function managedPackageNameFromDir(params: { npmRoot: string; packageDir: string }): string {
  return path
    .relative(path.join(params.npmRoot, "node_modules"), params.packageDir)
    .split(path.sep)
    .join("/");
}

async function auditAforaPeerDependency(params: {
  hostRoot: string;
  packageDir: string;
  npmRoot?: string;
  packageName?: string;
}): Promise<AforaPeerLinkAuditIssue | null> {
  const packageName =
    params.packageName ??
    (params.npmRoot
      ? managedPackageNameFromDir({
          npmRoot: params.npmRoot,
          packageDir: params.packageDir,
        })
      : path.basename(params.packageDir));
  const nodeModulesDir = path.join(params.packageDir, "node_modules");
  try {
    const existing = await fs.lstat(nodeModulesDir);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      return {
        packageName,
        packageDir: params.packageDir,
        reason: `${nodeModulesDir} is not a real directory`,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        packageName,
        packageDir: params.packageDir,
        reason: `missing ${path.join(nodeModulesDir, "afora")}`,
      };
    }
    throw error;
  }

  const linkPath = path.join(nodeModulesDir, "afora");
  const currentTarget = await safeRealpath(linkPath);
  if (!currentTarget) {
    return {
      packageName,
      packageDir: params.packageDir,
      reason: `missing ${linkPath}`,
    };
  }
  const expectedTarget = (await safeRealpath(params.hostRoot)) ?? params.hostRoot;
  if (currentTarget !== expectedTarget) {
    return {
      packageName,
      packageDir: params.packageDir,
      reason: `${linkPath} points to ${currentTarget} instead of ${expectedTarget}`,
    };
  }
  return null;
}

export async function auditAforaPeerDependencyLink(params: {
  packageDir: string;
  packageName?: string;
}): Promise<AforaPeerLinkAuditIssue | null> {
  const packageName = params.packageName ?? path.basename(params.packageDir);
  const hostRoot = resolveAforaPackageRootSync({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
    cwd: process.cwd(),
  });
  if (!hostRoot) {
    return {
      packageName,
      packageDir: params.packageDir,
      reason: "could not locate afora package root",
    };
  }
  return await auditAforaPeerDependency({
    hostRoot,
    packageDir: params.packageDir,
    packageName,
  });
}

/** Audit the installed host only when the package actually declares an Afora dependency. */
export async function auditDeclaredAforaHostDependency(params: {
  packageDir: string;
  packageName?: string;
}): Promise<AforaPeerLinkAuditIssue | null> {
  const dependencies = await readPackageAforaLinkDependencies(params.packageDir);
  if (!Object.hasOwn(dependencies, "afora")) {
    return null;
  }
  return await auditAforaPeerDependencyLink(params);
}

async function ensureRealNodeModulesDir(params: {
  installedDir: string;
  logger: PluginPeerLinkLogger;
}): Promise<string | null> {
  const nodeModulesDir = path.join(params.installedDir, "node_modules");
  try {
    const existing = await fs.lstat(nodeModulesDir);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      params.logger.warn?.(
        `Skipping afora peerDependency link because ${nodeModulesDir} is not a real directory.`,
      );
      return null;
    }
    return nodeModulesDir;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(nodeModulesDir, { recursive: true });
  const created = await fs.lstat(nodeModulesDir);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    params.logger.warn?.(
      `Skipping afora peerDependency link because ${nodeModulesDir} is not a real directory.`,
    );
    return null;
  }
  return nodeModulesDir;
}

async function linkAforaPeerDependency(params: {
  hostRoot: string;
  installedDir: string;
  peerName: string;
  logger: PluginPeerLinkLogger;
}): Promise<AforaPeerLinkResult> {
  const nodeModulesDir = await ensureRealNodeModulesDir({
    installedDir: params.installedDir,
    logger: params.logger,
  });
  if (!nodeModulesDir) {
    return "skipped";
  }

  const linkPath = path.join(nodeModulesDir, params.peerName);
  const expectedTarget = (await safeRealpath(params.hostRoot)) ?? params.hostRoot;
  const currentTarget = await safeRealpath(linkPath);
  if (currentTarget === expectedTarget) {
    return "unchanged";
  }

  try {
    const existing = await fs.lstat(linkPath).catch((err: unknown) => {
      if (hasErrnoCode(err, "ENOENT")) {
        return null;
      }
      throw err;
    });
    if (existing) {
      if (!existing.isSymbolicLink()) {
        if (params.peerName === "afora" && existing.isDirectory()) {
          const existingPackageName = await readPackageName(linkPath);
          if (existingPackageName === "afora") {
            await fs.rm(linkPath, { recursive: true, force: true });
            await fs.symlink(params.hostRoot, linkPath, "junction");
            params.logger.info?.(
              `Linked peerDependency "${params.peerName}" -> ${params.hostRoot}`,
            );
            return "linked";
          }
        }
        params.logger.warn?.(
          `Skipping afora peerDependency link because ${linkPath} already exists and is not a symlink.`,
        );
        return "skipped";
      }
      await fs.unlink(linkPath);
    }
    await fs.symlink(params.hostRoot, linkPath, "junction");
    params.logger.info?.(`Linked peerDependency "${params.peerName}" -> ${params.hostRoot}`);
    return "linked";
  } catch (err) {
    params.logger.warn?.(`Failed to symlink peerDependency "${params.peerName}": ${String(err)}`);
    return "skipped";
  }
}

async function readPackageName(packageDir: string): Promise<string | undefined> {
  const manifest = await readSafePackageManifest(packageDir);
  return typeof manifest?.name === "string" ? manifest.name : undefined;
}

/**
 * Symlink the host afora package for plugins that declare it as a dependency.
 * Plugin package managers still own third-party dependencies; this only wires
 * the host SDK package into the plugin-local Node graph.
 */
export async function linkAforaPeerDependencies(params: {
  installedDir: string;
  peerDependencies: Record<string, string>;
  logger: PluginPeerLinkLogger;
}): Promise<{ repaired: number; skipped: number }> {
  const peers = Object.keys(params.peerDependencies).filter((name) => name === "afora");
  if (peers.length === 0) {
    return { repaired: 0, skipped: 0 };
  }

  const hostRoot = resolveAforaPackageRootSync({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
    cwd: process.cwd(),
  });
  if (!hostRoot) {
    params.logger.warn?.(
      "Could not locate afora package root to symlink peerDependencies; plugin may fail to resolve afora at runtime.",
    );
    return { repaired: 0, skipped: peers.length };
  }

  let repaired = 0;
  let skipped = 0;
  for (const peerName of peers) {
    const result = await linkAforaPeerDependency({
      hostRoot,
      installedDir: params.installedDir,
      peerName,
      logger: params.logger,
    });
    if (result === "linked") {
      repaired += 1;
    } else if (result === "skipped") {
      skipped += 1;
    }
  }
  return { repaired, skipped };
}

/**
 * Repair only npm-owned legacy installs named by the authoritative install ledger.
 * Local/path installs and symlink escapes remain developer-owned and are never mutated.
 */
export async function reconcileRegisteredAforaHostLinks(params: {
  installRecords: Record<string, PluginInstallRecord>;
  extensionsDir: string;
  env?: NodeJS.ProcessEnv;
  mode: "audit" | "repair";
  logger?: PluginPeerLinkLogger;
  onPackageReadError?: (error: unknown, packageDir: string) => void;
}): Promise<RegisteredAforaHostLinkResult> {
  const extensionsRoot = path.resolve(params.extensionsDir);
  const extensionsRootRealPath = await safeRealpath(extensionsRoot);
  if (!extensionsRootRealPath) {
    return { checked: 0, repaired: 0, skipped: 0, issues: [] };
  }

  let checked = 0;
  let repaired = 0;
  let skipped = 0;
  const issues: AforaPeerLinkAuditIssue[] = [];
  for (const [pluginId, record] of Object.entries(params.installRecords).toSorted(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (record.source !== "npm" || !record.installPath?.trim()) {
      continue;
    }

    let packageDir: string;
    let expectedPackageDir: string;
    try {
      packageDir = path.resolve(resolveUserPath(record.installPath, params.env));
      expectedPackageDir = path.resolve(resolvePluginInstallDir(pluginId, extensionsRoot));
    } catch {
      continue;
    }
    if (packageDir !== expectedPackageDir) {
      continue;
    }

    const packageRealPath = await safeRealpath(packageDir);
    const expectedPackageRealPath = path.join(
      extensionsRootRealPath,
      path.relative(extensionsRoot, expectedPackageDir),
    );
    // Ledger paths cannot alias an outside directory or another developer-owned plugin in this root.
    if (
      !packageRealPath ||
      !isPathInside(extensionsRootRealPath, packageRealPath) ||
      packageRealPath !== expectedPackageRealPath
    ) {
      continue;
    }

    let dependencies: Record<string, string>;
    try {
      dependencies = await readPackageAforaLinkDependencies(packageDir);
    } catch (error) {
      if (!params.onPackageReadError) {
        throw error;
      }
      params.onPackageReadError(error, packageDir);
      skipped += 1;
      continue;
    }
    if (!Object.hasOwn(dependencies, "afora")) {
      continue;
    }
    checked += 1;

    const issue = await auditAforaPeerDependencyLink({
      packageDir,
      packageName: pluginId,
    });
    if (!issue) {
      continue;
    }
    issues.push(issue);
    if (params.mode !== "repair") {
      continue;
    }

    const result = await linkAforaPeerDependencies({
      installedDir: packageDir,
      peerDependencies: dependencies,
      logger: params.logger ?? {},
    });
    repaired += result.repaired;
    skipped += result.skipped;
  }
  return { checked, repaired, skipped, issues };
}

export async function relinkAforaPeerDependenciesInManagedNpmRoot(params: {
  npmRoot: string;
  logger: PluginPeerLinkLogger;
  onPackageReadError?: (error: unknown, packageDir: string) => void;
}): Promise<RelinkManagedNpmRootResult> {
  let checked = 0;
  let attempted = 0;
  let repaired = 0;
  let skipped = 0;
  for (const packageDir of await listManagedNpmRootPackageDirs(params.npmRoot)) {
    let aforaLinkDependencies: Record<string, string>;
    try {
      aforaLinkDependencies = await readPackageAforaLinkDependencies(packageDir);
    } catch (error) {
      if (!params.onPackageReadError) {
        throw error;
      }
      params.onPackageReadError(error, packageDir);
      skipped += 1;
      continue;
    }
    if (!Object.hasOwn(aforaLinkDependencies, "afora")) {
      continue;
    }
    checked += 1;
    const result = await linkAforaPeerDependencies({
      installedDir: packageDir,
      peerDependencies: aforaLinkDependencies,
      logger: params.logger,
    });
    attempted += 1;
    repaired += result.repaired;
    skipped += result.skipped;
  }
  return { checked, attempted, repaired, skipped };
}

export async function auditAforaPeerDependenciesInManagedNpmRoot(params: {
  npmRoot: string;
  onPackageReadError?: (error: unknown, packageDir: string) => void;
}): Promise<AuditManagedNpmRootResult> {
  const hostRoot = resolveAforaPackageRootSync({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
    cwd: process.cwd(),
  });
  if (!hostRoot) {
    return { checked: 0, broken: 0, issues: [] };
  }

  let checked = 0;
  const issues: AforaPeerLinkAuditIssue[] = [];
  for (const packageDir of await listManagedNpmRootPackageDirs(params.npmRoot)) {
    let aforaLinkDependencies: Record<string, string>;
    try {
      aforaLinkDependencies = await readPackageAforaLinkDependencies(packageDir);
    } catch (error) {
      if (!params.onPackageReadError) {
        throw error;
      }
      params.onPackageReadError(error, packageDir);
      continue;
    }
    if (!Object.hasOwn(aforaLinkDependencies, "afora")) {
      continue;
    }
    checked += 1;
    const issue = await auditAforaPeerDependency({
      hostRoot,
      npmRoot: params.npmRoot,
      packageDir,
    });
    if (issue) {
      issues.push(issue);
    }
  }
  return { checked, broken: issues.length, issues };
}
