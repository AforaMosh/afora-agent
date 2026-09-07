// Hook workspace tests cover workspace hook discovery and path handling.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: warnMock }),
}));

function writeHookPackageManifest(pkgDir: string, hooks: string[]): void {
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: "pkg",
        [MANIFEST_KEY]: {
          hooks,
        },
      },
      null,
      2,
    ),
  );
}

function setupHardlinkHookWorkspace(hookName: string): {
  hooksRoot: string;
  hookDir: string;
  outsideDir: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afora-hooks-workspace-hardlink-"));
  const hooksRoot = path.join(root, "hooks");
  fs.mkdirSync(hooksRoot, { recursive: true });

  const hookDir = path.join(hooksRoot, hookName);
  const outsideDir = path.join(root, "outside");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  return { hooksRoot, hookDir, outsideDir };
}

function tryCreateHardlinkOrSkip(createLink: () => void): boolean {
  try {
    createLink();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      return false;
    }
    throw err;
  }
}

function hookNames(entries: ReturnType<typeof loadWorkspaceHookEntries>): string[] {
  return entries.map((entry) => entry.hook.name);
}

function loadWorkspaceEntriesFromHooksRoot(hooksRoot: string) {
  const workspaceDir = path.dirname(hooksRoot);
  return loadWorkspaceHookEntries(workspaceDir, {
    managedHooksDir: path.join(workspaceDir, "managed-none"),
    bundledHooksDir: path.join(workspaceDir, "bundled-none"),
  });
}

const METADATA_MAX_BYTES = 1024 * 1024;

function writePlainHook(hooksRoot: string, name: string, content?: string): string {
  const hookDir = path.join(hooksRoot, name);
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, "HOOK.md"), content ?? `---\nname: ${name}\n---\n`);
  fs.writeFileSync(path.join(hookDir, "handler.js"), "export default async () => {};\n");
  return hookDir;
}

function oversizedMetadataWarnings(filePath: string): string[] {
  return warnMock.mock.calls
    .map(([message]) => String(message))
    .filter((message) => message.includes(filePath) && message.includes(`${METADATA_MAX_BYTES}`));
}

function padToExactBytes(content: string, targetBytes: number): string {
  const padding = targetBytes - Buffer.byteLength(content, "utf8");
  return padding > 0 ? content + " ".repeat(padding) : content;
}

function exactSizeHookPackageManifest(targetBytes: number): string {
  const base = { name: "pkg", [MANIFEST_KEY]: { hooks: ["./nested"] }, pad: "" };
  const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
  return JSON.stringify({ ...base, pad: "x".repeat(targetBytes - baseBytes) });
}

describe("hooks workspace", () => {
  beforeEach(() => {
    warnMock.mockClear();
  });

  it("ignores package.json hook paths that traverse outside package directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afora-hooks-workspace-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const pkgDir = path.join(hooksRoot, "pkg");
    fs.mkdirSync(pkgDir, { recursive: true });

    const outsideHookDir = path.join(root, "outside");
    fs.mkdirSync(outsideHookDir, { recursive: true });
    fs.writeFileSync(path.join(outsideHookDir, "HOOK.md"), "---\nname: outside\n---\n");
    fs.writeFileSync(path.join(outsideHookDir, "handler.js"), "export default async () => {};\n");

    writeHookPackageManifest(pkgDir, ["../outside"]);

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).not.toContain("outside");
  });

  it("accepts package.json hook paths within package directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afora-hooks-workspace-ok-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const pkgDir = path.join(hooksRoot, "pkg");
    const nested = path.join(pkgDir, "nested");
    fs.mkdirSync(nested, { recursive: true });

    fs.writeFileSync(path.join(nested, "HOOK.md"), "---\nname: nested\n---\n");
    fs.writeFileSync(path.join(nested, "handler.js"), "export default async () => {};\n");

    writeHookPackageManifest(pkgDir, ["./nested"]);

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).toContain("nested");
  });

  it("warns, skips oversized metadata, and continues discovering other hooks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afora-hooks-oversized-mixed-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const packageDir = path.join(hooksRoot, "big-package");
    fs.mkdirSync(packageDir);
    const manifestPath = path.join(packageDir, "package.json");
    fs.writeFileSync(manifestPath, "x".repeat(METADATA_MAX_BYTES + 1));

    const bigHookDir = writePlainHook(hooksRoot, "big-hook", "x".repeat(METADATA_MAX_BYTES + 1));
    const bigHookMdPath = path.join(bigHookDir, "HOOK.md");
    writePlainHook(hooksRoot, "small-hook");

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).toEqual(["small-hook"]);
    expect(oversizedMetadataWarnings(manifestPath)).toHaveLength(1);
    expect(oversizedMetadataWarnings(bigHookMdPath)).toHaveLength(1);
  });

  it("loads hooks whose metadata sits exactly at the byte limit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afora-hooks-exact-limit-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const pkgDir = path.join(hooksRoot, "pkg");
    const nested = path.join(pkgDir, "nested");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      exactSizeHookPackageManifest(METADATA_MAX_BYTES),
    );
    fs.writeFileSync(
      path.join(nested, "HOOK.md"),
      padToExactBytes("---\nname: exact-limit\n---\n", METADATA_MAX_BYTES),
    );
    fs.writeFileSync(path.join(nested, "handler.js"), "export default async () => {};\n");

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).toContain("exact-limit");
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("still loads a plain hook when its package.json is oversized", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afora-hooks-oversized-compat-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const hookDir = writePlainHook(hooksRoot, "compat-hook");
    const manifestPath = path.join(hookDir, "package.json");
    fs.writeFileSync(manifestPath, "x".repeat(METADATA_MAX_BYTES + 1), "utf8");

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).toContain("compat-hook");
    expect(oversizedMetadataWarnings(manifestPath)).toHaveLength(1);
  });

  it("ignores package.json hook paths that escape via symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afora-hooks-workspace-link-"));
    const hooksRoot = path.join(root, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });

    const pkgDir = path.join(hooksRoot, "pkg");
    const outsideDir = path.join(root, "outside");
    const linkedDir = path.join(pkgDir, "linked");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "HOOK.md"), "---\nname: outside\n---\n");
    fs.writeFileSync(path.join(outsideDir, "handler.js"), "export default async () => {};\n");
    try {
      fs.symlinkSync(outsideDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    writeHookPackageManifest(pkgDir, ["./linked"]);

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).not.toContain("outside");
  });

  it("ignores hooks with hardlinked HOOK.md aliases", () => {
    if (process.platform === "win32") {
      return;
    }

    const { hooksRoot, hookDir, outsideDir } = setupHardlinkHookWorkspace("hardlink-hook");
    fs.writeFileSync(path.join(hookDir, "handler.js"), "export default async () => {};\n");
    const outsideHookMd = path.join(outsideDir, "HOOK.md");
    const linkedHookMd = path.join(hookDir, "HOOK.md");
    fs.writeFileSync(linkedHookMd, "---\nname: hardlink-hook\n---\n");
    fs.rmSync(linkedHookMd);
    fs.writeFileSync(outsideHookMd, "---\nname: outside\n---\n");
    if (!tryCreateHardlinkOrSkip(() => fs.linkSync(outsideHookMd, linkedHookMd))) {
      return;
    }

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    const names = hookNames(entries);
    expect(names).not.toContain("hardlink-hook");
    expect(names).not.toContain("outside");
  });

  it("ignores hooks with hardlinked handler aliases", () => {
    if (process.platform === "win32") {
      return;
    }

    const { hooksRoot, hookDir, outsideDir } = setupHardlinkHookWorkspace("hardlink-handler-hook");
    fs.writeFileSync(path.join(hookDir, "HOOK.md"), "---\nname: hardlink-handler-hook\n---\n");
    const outsideHandler = path.join(outsideDir, "handler.js");
    const linkedHandler = path.join(hookDir, "handler.js");
    fs.writeFileSync(outsideHandler, "export default async () => {};\n");
    if (!tryCreateHardlinkOrSkip(() => fs.linkSync(outsideHandler, linkedHandler))) {
      return;
    }

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).not.toContain("hardlink-handler-hook");
  });

  it("does not let workspace hooks override managed hooks with the same name", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afora-hooks-collision-"));
    const workspaceDir = path.join(root, "workspace");
    const managedHooksDir = path.join(root, "managed-hooks");
    const workspaceHookDir = path.join(workspaceDir, "hooks", "session-memory");
    const managedHookDir = path.join(managedHooksDir, "session-memory");
    fs.mkdirSync(workspaceHookDir, { recursive: true });
    fs.mkdirSync(managedHookDir, { recursive: true });

    for (const dir of [workspaceHookDir, managedHookDir]) {
      fs.writeFileSync(
        path.join(dir, "HOOK.md"),
        [
          "---",
          "name: session-memory",
          'metadata: {"afora":{"events":["command:new"]}}',
          "---",
        ].join("\n"),
      );
      fs.writeFileSync(path.join(dir, "handler.js"), "export default async () => {};\n");
    }

    const entries = loadWorkspaceHookEntries(workspaceDir, {
      managedHooksDir,
      bundledHooksDir: path.join(root, "bundled-none"),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hook.source).toBe("afora-managed");
  });

  it("treats configured extraDirs as managed hook sources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afora-hooks-extra-"));
    const workspaceDir = path.join(root, "workspace");
    const extraHookDir = path.join(root, "shared-hooks", "shared-hook");
    fs.mkdirSync(extraHookDir, { recursive: true });
    fs.writeFileSync(
      path.join(extraHookDir, "HOOK.md"),
      ["---", "name: shared-hook", 'metadata: {"afora":{"events":["command:new"]}}', "---"].join(
        "\n",
      ),
    );
    fs.writeFileSync(path.join(extraHookDir, "handler.js"), "export default async () => {};\n");

    const entries = loadWorkspaceHookEntries(workspaceDir, {
      bundledHooksDir: path.join(root, "bundled-none"),
      config: {
        hooks: {
          internal: {
            enabled: true,
            load: {
              extraDirs: [path.join(root, "shared-hooks")],
            },
          },
        },
      },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.hook.name).toBe("shared-hook");
    expect(entries[0]?.hook.source).toBe("afora-managed");
  });

  // afora-compat: a hook pack published before the rename declares `openclaw.hooks`. Reading only
  // the canonical key returns an empty list rather than an error, so the loader falls through to
  // the single-HOOK.md path and the pack's hooks silently stop existing.
  it("loads every hook a package declares under the legacy manifest key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afora-hooks-workspace-legacy-"));
    const hooksRoot = path.join(root, "hooks");
    const pkgDir = path.join(hooksRoot, "pkg");
    for (const name of ["a", "b"]) {
      const nested = path.join(pkgDir, "hooks", name);
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "HOOK.md"), `---\nname: legacy-${name}\n---\n`);
      fs.writeFileSync(path.join(nested, "handler.js"), "export default async () => {};\n");
    }
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", openclaw: { hooks: ["./hooks/a", "./hooks/b"] } }),
    );

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries).toSorted()).toEqual(["legacy-a", "legacy-b"]);
  });

  it("prefers the canonical manifest key when a package declares both", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afora-hooks-workspace-both-"));
    const hooksRoot = path.join(root, "hooks");
    const pkgDir = path.join(hooksRoot, "pkg");
    for (const name of ["current", "legacy"]) {
      const nested = path.join(pkgDir, name);
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "HOOK.md"), `---\nname: ${name}\n---\n`);
      fs.writeFileSync(path.join(nested, "handler.js"), "export default async () => {};\n");
    }
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pkg",
        [MANIFEST_KEY]: { hooks: ["./current"] },
        openclaw: { hooks: ["./legacy"] },
      }),
    );

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).toEqual(["current"]);
  });

  // The half-migrated shape: the package has been given an `afora` section for something else and
  // still declares its hooks under the old key. Returning on the first defined key reads
  // `afora.hooks` as absent and loads nothing.
  it("does not let a canonical section without hooks shadow a legacy one that has them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "afora-hooks-workspace-shadow-"));
    const hooksRoot = path.join(root, "hooks");
    const pkgDir = path.join(hooksRoot, "pkg");
    const nested = path.join(pkgDir, "nested");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "HOOK.md"), "---\nname: nested\n---\n");
    fs.writeFileSync(path.join(nested, "handler.js"), "export default async () => {};\n");
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pkg",
        [MANIFEST_KEY]: { plugin: { id: "pkg" } },
        openclaw: { hooks: ["./nested"] },
      }),
    );

    const entries = loadWorkspaceEntriesFromHooksRoot(hooksRoot);
    expect(hookNames(entries)).toEqual(["nested"]);
  });
});
