// Plugin SDK specifier spelling tests keep in-repo SDK guidance on an importable package name.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLUGIN_SDK_PACKAGE_NAMES } from "../sdk-alias.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SCANNED_ROOTS = ["src", "packages", "AGENTS.md"] as const;
const SCANNED_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx", ".md"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "dist-runtime"]);
const PLUGIN_SDK_SUFFIX = "/plugin-sdk";

// A `<package>/plugin-sdk` token, with or without a trailing subpath, that is not preceded by a
// path separator, a dot, an `@`, or a word character. That lookbehind is what keeps repo-relative
// paths such as `dist/extensions/node_modules/afora/plugin-sdk/core.js` out of the scan while
// still matching the same token where it stands alone as a module specifier.
const SPECIFIER_PATTERN =
  /(?<![\w./@-])(@?[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?)\/plugin-sdk(?:\/([a-z0-9*][a-z0-9-]*))?(?![\w.-])/gu;

// `collectDeprecatedInternalConfigApiViolations` builds these strings in
// scripts/lib/config-boundary-guard.mts, which is outside the debrand loop's edit fence, so the
// expectations here have to keep matching the producer until a human moves both together. The
// staleness assertion below deletes this entry for whoever does.
const KNOWN_UNFIXED_FILES = new Map<string, string>([
  [
    "src/plugins/contracts/config-boundary-guard.test.ts",
    "mirrors violation text built in scripts/lib/config-boundary-guard.mts",
  ],
]);

type SpecifierHit = { file: string; line: number; packageName: string; specifier: string };

function* walkFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

function collectScannedFiles(): string[] {
  const files: string[] = [];
  for (const root of SCANNED_ROOTS) {
    const full = path.join(REPO_ROOT, root);
    if (!fs.existsSync(full)) {
      continue;
    }
    if (fs.statSync(full).isDirectory()) {
      files.push(...walkFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

function collectPluginSdkSpecifierHits(): SpecifierHit[] {
  const hits: SpecifierHit[] = [];
  for (const file of collectScannedFiles()) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, index) => {
        for (const match of text.matchAll(SPECIFIER_PATTERN)) {
          const packageName = match[1] ?? "";
          // A package half that names a directory at the repo root is a repo-relative path
          // (`packages/plugin-sdk/types`), not a module specifier. Derived from the tree so a
          // new top-level directory does not need a list entry here.
          if (fs.existsSync(path.join(REPO_ROOT, packageName))) {
            continue;
          }
          hits.push({ file: relative, line: index + 1, packageName, specifier: match[0] });
        }
      });
  }
  return hits;
}

function readPackageName(manifestPath: string): string {
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const name = (parsed as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

// The names this checkout can actually be addressed by: the root manifest's own name, which is
// what mints the `node_modules/<name> -> ..` workspace self-link every in-tree extension imports
// the host through, plus any workspace package whose own name IS a plugin-sdk package.
function collectAddressablePluginSdkPackageNames(): Set<string> {
  const names = new Set<string>([
    `${readPackageName(path.join(REPO_ROOT, "package.json"))}${PLUGIN_SDK_SUFFIX}`,
  ]);
  const packagesDir = path.join(REPO_ROOT, "packages");
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    const manifest = path.join(packagesDir, entry.name, "package.json");
    if (!entry.isDirectory() || !fs.existsSync(manifest)) {
      continue;
    }
    const name = readPackageName(manifest);
    if (name.endsWith(PLUGIN_SDK_SUFFIX)) {
      names.add(name);
    }
  }
  return names;
}

describe("plugin SDK specifier spelling", () => {
  // The debrand codemod had two target spellings and chose between them per line: package.json
  // publishes `afora-agent`, so `afora-agent/plugin-sdk/<subpath>` resolves and the bare-brand
  // spelling beside it is MODULE_NOT_FOUND. Every `@deprecated ... use X` under src/plugin-sdk
  // reaches a plugin author through the published .d.ts, so a dead specifier there is migration
  // guidance nobody can follow, and nothing goes red when it rots: the file contains no wrong
  // word. Read the allowed package names from the same constant
  // `resolvePluginSdkScopedAliasMap` mints its alias keys from, so a later rename moves the
  // guidance and this assertion together instead of splitting them again. An entry that does not
  // carry the subpath suffix is dropped rather than truncated, so a malformed constant fails
  // closed here and is named by the addressability test below.
  const allowedPackageNames = new Set(
    PLUGIN_SDK_PACKAGE_NAMES.filter((name) => name.endsWith(PLUGIN_SDK_SUFFIX)).map((name) =>
      name.slice(0, -PLUGIN_SDK_SUFFIX.length),
    ),
  );

  it("names Plugin SDK subpaths under a package the alias map is minted under", () => {
    const offenders = collectPluginSdkSpecifierHits()
      .filter((hit) => !allowedPackageNames.has(hit.packageName))
      .filter((hit) => !KNOWN_UNFIXED_FILES.has(hit.file))
      .map((hit) => `${hit.file}:${hit.line} ${hit.specifier}`);

    expect(offenders).toEqual([]);
  });

  it("keeps every allowed Plugin SDK package name addressable in this checkout", () => {
    // The allow-list above is only as good as the constant it reads: adding a plausible
    // back-compat entry for a spelling nothing can import would silently re-admit the dead one
    // everywhere, and the test above would go green while the guidance stayed broken. Ask the
    // checkout instead of trusting the constant, and derive the answer from the manifests rather
    // than spelling any package name here.
    const addressable = collectAddressablePluginSdkPackageNames();
    const unaddressable = PLUGIN_SDK_PACKAGE_NAMES.filter((name) => !addressable.has(name));

    expect(unaddressable).toEqual([]);
    expect(addressable.size).toBeGreaterThan(0);
  });

  it("scans a tree that actually carries Plugin SDK specifiers", () => {
    // A sweep that walks the wrong root finds nothing and passes, which is indistinguishable
    // from a clean tree. Pin the shape of a non-vacuous scan instead.
    const hits = collectPluginSdkSpecifierHits();
    const allowed = hits.filter((hit) => allowedPackageNames.has(hit.packageName));

    expect(allowed.length).toBeGreaterThan(100);
    expect(new Set(allowed.map((hit) => hit.file)).size).toBeGreaterThan(10);
  });

  it("drops a known-unfixed exemption once its out-of-fence producer moves", () => {
    // Each exemption is live only while its file still carries an offender. When the producer is
    // repaired the entry stops describing anything, and this fails rather than quietly widening.
    const offendersByFile = new Set(
      collectPluginSdkSpecifierHits()
        .filter((hit) => !allowedPackageNames.has(hit.packageName))
        .map((hit) => hit.file),
    );

    const stale = [...KNOWN_UNFIXED_FILES]
      .filter(([file]) => !offendersByFile.has(file))
      .map(([file, reason]) => `${file} no longer carries an offender (${reason})`);

    expect(stale).toEqual([]);
  });
});
