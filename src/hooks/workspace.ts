// Hook workspace helpers resolve hook roots and workspace-local hook files.
import fs from "node:fs";
import path from "node:path";
import { safeParseJson } from "@afora/normalization-core";
import { normalizeTrimmedStringList } from "@afora/normalization-core/string-normalization";
import {
  LEGACY_MANIFEST_KEYS,
  MANIFEST_KEY,
  manifestSectionDeclares,
  readManifestSection,
} from "../compat/legacy-names.js";
import type { AforaConfig } from "../config/types.afora.js";
import { openRootFileSync, readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPathInsideWithRealpath } from "../security/scan-paths.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import { resolveBundledHooksDir } from "./bundled-dir.js";
import {
  parseHookFrontmatter,
  resolveHookInvocationPolicy,
  resolveHookManifestMetadata,
} from "./frontmatter.js";
import { resolvePluginHookDirs } from "./plugin-hooks.js";
import { resolveHookEntries } from "./policy.js";
import type { Hook, HookEntry, HookSource, ParsedHookFrontmatter } from "./types.js";

// Hook descriptors are small metadata. Bounding the pinned descriptor read also
// covers files that grow after the boundary open validates their identity.
const HOOK_METADATA_MAX_BYTES = 1024 * 1024;

type HookPackageManifest = {
  name?: string;
} & Partial<
  Record<typeof MANIFEST_KEY | (typeof LEGACY_MANIFEST_KEYS)[number], { hooks?: string[] }>
>;
const log = createSubsystemLogger("hooks/workspace");

type LoadedHook = {
  hook: Hook;
  frontmatter: ParsedHookFrontmatter;
};

function readHookPackageManifest(dir: string): HookPackageManifest | null {
  const manifestPath = path.join(dir, "package.json");
  const raw = readRootFileUtf8({
    absolutePath: manifestPath,
    rootPath: dir,
    boundaryLabel: "hook package directory",
    maxBytes: HOOK_METADATA_MAX_BYTES,
  });
  if (raw === null) {
    return null;
  }
  return (safeParseJson(raw) as HookPackageManifest | undefined) ?? null;
}

// afora-compat: a hook pack published before the rename declares `openclaw.hooks`. Reading only
// the canonical key does not error here, it returns an empty list, and the caller then falls
// through to the single-HOOK.md path and registers nothing at all. Silent, so the tenant's hooks
// simply stop firing.
const DECLARES_HOOKS = manifestSectionDeclares("hooks");

function resolvePackageHooks(manifest: HookPackageManifest): string[] {
  const section = readManifestSection(manifest, DECLARES_HOOKS);
  return normalizeTrimmedStringList((section as { hooks?: unknown } | undefined)?.hooks);
}

function resolveContainedDir(baseDir: string, targetDir: string): string | null {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(baseDir, targetDir);
  if (
    !isPathInsideWithRealpath(base, resolved, {
      requireRealpath: true,
    })
  ) {
    return null;
  }
  return resolved;
}

function loadHookFromDir(params: {
  hookDir: string;
  source: HookSource;
  pluginId?: string;
  nameHint?: string;
}): LoadedHook | null {
  const hookMdPath = path.join(params.hookDir, "HOOK.md");
  const content = readRootFileUtf8({
    absolutePath: hookMdPath,
    rootPath: params.hookDir,
    boundaryLabel: "hook directory",
    maxBytes: HOOK_METADATA_MAX_BYTES,
  });
  if (content === null) {
    return null;
  }
  try {
    const frontmatter = parseHookFrontmatter(content);

    const name = frontmatter.name || params.nameHint || path.basename(params.hookDir);
    const description = frontmatter.description || "";

    const handlerCandidates = ["handler.ts", "handler.js", "index.ts", "index.js"];
    let handlerPath: string | undefined;
    for (const candidate of handlerCandidates) {
      const candidatePath = path.join(params.hookDir, candidate);
      const safeCandidatePath = resolveRootFilePath({
        absolutePath: candidatePath,
        rootPath: params.hookDir,
        boundaryLabel: "hook directory",
      });
      if (safeCandidatePath) {
        handlerPath = safeCandidatePath;
        break;
      }
    }

    if (!handlerPath) {
      log.warn(`Hook "${name}" has HOOK.md but no handler file in ${params.hookDir}`);
      return null;
    }

    let baseDir = params.hookDir;
    try {
      baseDir = fs.realpathSync.native(params.hookDir);
    } catch {
      // keep the discovered path when realpath is unavailable
    }

    return {
      hook: {
        name,
        description,
        source: params.source,
        pluginId: params.pluginId,
        filePath: hookMdPath,
        baseDir,
        handlerPath,
      },
      frontmatter,
    };
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.warn(`Failed to load hook from ${params.hookDir}: ${message}`);
    return null;
  }
}

/**
 * Scan a directory for hooks (subdirectories containing HOOK.md)
 */
function loadHooksFromDir(params: {
  dir: string;
  source: HookSource;
  pluginId?: string;
}): LoadedHook[] {
  const { dir, source, pluginId } = params;

  if (!fs.existsSync(dir)) {
    return [];
  }

  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    return [];
  }

  const hooks: LoadedHook[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const hookDir = path.join(dir, entry.name);
    const manifest = readHookPackageManifest(hookDir);
    const packageHooks = manifest ? resolvePackageHooks(manifest) : [];

    if (packageHooks.length > 0) {
      for (const hookPath of packageHooks) {
        const resolvedHookDir = resolveContainedDir(hookDir, hookPath);
        if (!resolvedHookDir) {
          log.warn(
            `Ignoring out-of-package hook path "${hookPath}" in ${hookDir} (must be within package directory)`,
          );
          continue;
        }
        const hook = loadHookFromDir({
          hookDir: resolvedHookDir,
          source,
          pluginId,
          nameHint: path.basename(resolvedHookDir),
        });
        if (hook) {
          hooks.push(hook);
        }
      }
      continue;
    }

    const hook = loadHookFromDir({
      hookDir,
      source,
      pluginId,
      nameHint: entry.name,
    });
    if (hook) {
      hooks.push(hook);
    }
  }

  return hooks;
}

function loadHookEntriesFromDir(params: {
  dir: string;
  source: HookSource;
  pluginId?: string;
}): HookEntry[] {
  const hooks = loadHooksFromDir({
    dir: params.dir,
    source: params.source,
    pluginId: params.pluginId,
  });
  return hooks.map(({ hook, frontmatter }) => {
    const entry: HookEntry = {
      hook: {
        ...hook,
        source: params.source,
        pluginId: params.pluginId,
      },
      frontmatter,
      metadata: resolveHookManifestMetadata(frontmatter),
      invocation: resolveHookInvocationPolicy(frontmatter),
    };
    return entry;
  });
}

function discoverWorkspaceHookEntries(
  workspaceDir: string,
  opts?: {
    config?: AforaConfig;
    managedHooksDir?: string;
    bundledHooksDir?: string;
  },
): HookEntry[] {
  const managedHooksDir = opts?.managedHooksDir ?? path.join(CONFIG_DIR, "hooks");
  const workspaceHooksDir = path.join(workspaceDir, "hooks");
  const bundledHooksDir = opts?.bundledHooksDir ?? resolveBundledHooksDir();
  const extraDirsRaw = opts?.config?.hooks?.internal?.load?.extraDirs ?? [];
  const extraDirs = normalizeTrimmedStringList(extraDirsRaw);
  const pluginHookDirs = resolvePluginHookDirs({
    workspaceDir,
    config: opts?.config,
  });

  const bundledHooks = bundledHooksDir
    ? loadHookEntriesFromDir({
        dir: bundledHooksDir,
        source: "afora-bundled",
      })
    : [];
  const extraHooks = extraDirs.flatMap((dir) => {
    const resolved = resolveUserPath(dir);
    return loadHookEntriesFromDir({
      dir: resolved,
      source: "afora-managed",
    });
  });
  const pluginHooks = pluginHookDirs.flatMap(({ dir, pluginId }) =>
    loadHookEntriesFromDir({
      dir,
      source: "afora-plugin",
      pluginId,
    }),
  );
  const managedHooks = loadHookEntriesFromDir({
    dir: managedHooksDir,
    source: "afora-managed",
  });
  const workspaceHooks = loadHookEntriesFromDir({
    dir: workspaceHooksDir,
    source: "afora-workspace",
  });

  return [...extraHooks, ...bundledHooks, ...pluginHooks, ...managedHooks, ...workspaceHooks];
}

export function loadWorkspaceHookEntries(
  workspaceDir: string,
  opts?: {
    config?: AforaConfig;
    managedHooksDir?: string;
    bundledHooksDir?: string;
    entries?: HookEntry[];
  },
): HookEntry[] {
  return resolveHookEntries(opts?.entries ?? discoverWorkspaceHookEntries(workspaceDir, opts), {
    onCollisionIgnored: ({ name, kept, ignored }) => {
      log.warn(
        `Ignoring ${ignored.hook.source} hook "${name}" because it cannot override ${kept.hook.source} hook code`,
      );
    },
  });
}

function readRootFileUtf8(params: {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  maxBytes: number;
}): string | null {
  return withOpenedRootFileSync(params, (opened) => {
    try {
      return readFileDescriptorBoundedSync(opened.fd, params.maxBytes).toString("utf-8");
    } catch (err) {
      if (err instanceof RangeError) {
        log.warn(
          `Ignoring oversized hook metadata ${params.absolutePath}: file exceeds the ${params.maxBytes}-byte limit`,
        );
      }
      return null;
    }
  });
}

function withOpenedRootFileSync<T>(
  params: {
    absolutePath: string;
    rootPath: string;
    boundaryLabel: string;
  },
  read: (opened: { fd: number; path: string }) => T,
): T | null {
  const opened = openRootFileSync({
    absolutePath: params.absolutePath,
    rootPath: params.rootPath,
    boundaryLabel: params.boundaryLabel,
    // Operator hook dirs are commonly symlinked; fs-safe still rejects hops
    // whose canonical target escapes the hook root.
    rejectSymlinks: false,
  });
  if (!opened.ok) {
    return null;
  }
  try {
    return read({ fd: opened.fd, path: opened.path });
  } finally {
    fs.closeSync(opened.fd);
  }
}

function resolveRootFilePath(params: {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
}): string | null {
  return withOpenedRootFileSync(params, (opened) => opened.path);
}
