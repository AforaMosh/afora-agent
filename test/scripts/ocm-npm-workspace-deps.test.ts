import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildInstallManifest,
  parseWorkspaceDependencyDirs,
  resolveNpmEnvironment,
  resolveRuntimePackEnvironment,
  resolveRuntimePackPlan,
  resolveWorkspaceInstallPlan,
  restoreRuntimePack,
  rewriteWorkspaceDependencyVersions,
  runPreparedRuntimePack,
} from "../../scripts/ocm-npm-workspace-deps.mts";
import { restorePrepackArtifacts } from "../../scripts/afora-postpack.mjs";
import { preparePackageChangelog } from "../../scripts/package-changelog.mjs";
import { preparePackageDocsMap } from "../../scripts/package-docs-map.mjs";

const adapterPath = fileURLToPath(
  new URL("../../scripts/ocm-npm-workspace-deps.mts", import.meta.url),
);
const packageDocsMapPath = fileURLToPath(
  new URL("../../scripts/package-docs-map.mjs", import.meta.url),
);
const packageChangelogPath = fileURLToPath(
  new URL("../../scripts/package-changelog.mjs", import.meta.url),
);
const postpackPath = fileURLToPath(new URL("../../scripts/afora-postpack.mjs", import.meta.url));

describe("OCM npm workspace dependency adapter", () => {
  it("allows Unreleased notes only for non-publishing pack commands", () => {
    const env = { KEEP: "value" };
    expect(resolveNpmEnvironment(["install"], env)).toBe(env);
    expect(resolveNpmEnvironment(["pack", "--silent"], env)).toEqual({
      KEEP: "value",
      OCM_INTERNAL_NPM_BIN: adapterPath,
      AFORA_PREPACK_ALLOW_UNRELEASED_CHANGELOG: "1",
    });
  });

  it("uses a prepared runtime-only pack for the diagnostic build profile", () => {
    expect(
      resolveRuntimePackPlan(["pack", "--pack-destination", "/tmp/out"], {
        AFORA_OCM_RUNTIME_BUILD_PROFILE: "sourcePerformance",
      }),
    ).toEqual({
      profile: "sourcePerformance",
      packArgs: ["pack", "--pack-destination", "/tmp/out", "--ignore-scripts"],
    });
  });

  it("keeps normal package builds on the full prepack path", () => {
    expect(resolveRuntimePackPlan(["pack"], {})).toBeNull();
    expect(
      resolveRuntimePackPlan(["install"], {
        AFORA_OCM_RUNTIME_BUILD_PROFILE: "sourcePerformance",
      }),
    ).toBeNull();
  });

  it("rejects unsupported runtime build profiles", () => {
    expect(() =>
      resolveRuntimePackPlan(["pack"], {
        AFORA_OCM_RUNTIME_BUILD_PROFILE: "qaRuntime",
      }),
    ).toThrow("invalid AFORA_OCM_RUNTIME_BUILD_PROFILE: qaRuntime");
  });

  it("pins one timestamp and commit across the prepared runtime pack", () => {
    const env = resolveRuntimePackEnvironment(
      { KEEP: "value" },
      () => new Date("2026-07-11T12:34:56.000Z"),
      () => "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
    );

    expect(env).toMatchObject({
      KEEP: "value",
      GIT_COMMIT: "abcdef0123456789abcdef0123456789abcdef01",
      AFORA_BUILD_TIMESTAMP: "2026-07-11T12:34:56.000Z",
    });
  });

  it("rejects ambiguous runtime pack commits", () => {
    expect(() =>
      resolveRuntimePackEnvironment(
        { GITHUB_SHA: "abc123" },
        () => new Date("2026-07-11T12:34:56.000Z"),
        () => null,
      ),
    ).toThrow("runtime pack commit must be a full 40-character hexadecimal SHA");
  });

  it("does not let a failed concurrent owner restore the active pack lifecycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "afora-ocm-pack-owner-"));
    const docsDir = join(root, "docs");
    const mapPath = join(docsDir, "docs_map.md");
    const receiptPath = join(root, ".artifacts", "package-docs-map", "receipt.json");
    const changelogBackupPath = join(
      root,
      ".artifacts",
      "package-changelog",
      "CHANGELOG.md.prepack-backup",
    );
    const sourceMap = "# Docs map source\n";
    const sourceChangelog = `# Changelog

## 2026.8.1
- Current release notes with enough detail for package validation.

## 2026.7.1
- Previous release notes with enough detail for package validation.
`;
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "page.md"), "# Package docs\n");
    writeFileSync(mapPath, sourceMap);
    writeFileSync(join(root, "package.json"), '{"name":"afora","version":"2026.8.1"}\n');
    writeFileSync(join(root, "CHANGELOG.md"), sourceChangelog);

    try {
      await preparePackageDocsMap(root);
      await preparePackageChangelog(root);
      const activeMap = readFileSync(mapPath, "utf8");
      const activeChangelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
      let packCalled = false;

      expect(() =>
        runPreparedRuntimePack(
          () =>
            execFileSync(process.execPath, [packageDocsMapPath, "prepare"], {
              cwd: root,
              stdio: "pipe",
            }),
          () => {
            packCalled = true;
            return 0;
          },
          () => execFileSync(process.execPath, [postpackPath], { cwd: root, stdio: "pipe" }),
        ),
      ).toThrow();

      expect(packCalled).toBe(false);
      expect(existsSync(receiptPath)).toBe(true);
      expect(existsSync(changelogBackupPath)).toBe(true);
      expect(readFileSync(mapPath, "utf8")).toBe(activeMap);
      expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(activeChangelog);

      await restorePrepackArtifacts(root);
      expect(readFileSync(mapPath, "utf8")).toBe(sourceMap);
      expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(sourceChangelog);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("restores a prepared legacy source fixture through its changelog owner", () => {
    const root = mkdtempSync(join(tmpdir(), "afora-ocm-historical-pack-"));
    const scriptsDir = join(root, "scripts");
    const sourceChangelog = `# Changelog

## 2026.8.1
- Current release notes with enough detail for package validation.

## 2026.7.1
- Previous release notes with enough detail for package validation.
`;
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"name":"afora","version":"2026.8.1"}\n');
    writeFileSync(join(root, "CHANGELOG.md"), sourceChangelog);

    try {
      writeFileSync(
        join(scriptsDir, "package-changelog.mjs"),
        readFileSync(packageChangelogPath, "utf8"),
      );
      execFileSync(process.execPath, ["scripts/package-changelog.mjs", "prepare"], {
        cwd: root,
        stdio: "pipe",
      });
      expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).not.toBe(sourceChangelog);
      expect(existsSync(join(root, "scripts", "afora-postpack.mjs"))).toBe(false);

      restoreRuntimePack(process.env, root);

      expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(sourceChangelog);
      expect(
        existsSync(join(root, ".artifacts", "package-changelog", "CHANGELOG.md.prepack-backup")),
      ).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("resolves workspace package directories", () => {
    expect(
      parseWorkspaceDependencyDirs(["packages/ai", "extensions/example"].join(delimiter), "/repo"),
    ).toEqual(["/repo/packages/ai", "/repo/extensions/example"]);
  });

  it("replaces the root archive argument with a prepared install manifest", () => {
    expect(
      resolveWorkspaceInstallPlan(
        [
          "install",
          "--prefix",
          "runtime",
          "--omit=dev",
          "--no-save",
          "--package-lock=false",
          "afora.tgz",
        ],
        ["/repo/packages/ai"],
        "/repo",
      ),
    ).toEqual({
      installArgs: [
        "install",
        "--prefix",
        "runtime",
        "--omit=dev",
        "--no-save",
        "--package-lock=false",
      ],
      prefixDir: "/repo/runtime",
      rootArchive: "/repo/afora.tgz",
    });
  });

  it("keeps normal npm commands unchanged", () => {
    expect(resolveWorkspaceInstallPlan(["pack", "--silent"], ["/repo/packages/ai"])).toBeNull();
    expect(resolveWorkspaceInstallPlan(["install", "afora.tgz"], [])).toBeNull();
  });

  it("builds a manifest with the root and local workspace tarballs", () => {
    expect(
      buildInstallManifest("/tmp/afora.tgz", [
        { name: "@afora/ai", tarball: "/tmp/afora-ai.tgz" },
      ]),
    ).toEqual({
      private: true,
      dependencies: {
        "@afora/ai": "file:///tmp/afora-ai.tgz",
        afora: "file:///tmp/afora.tgz",
      },
    });
  });

  it("rewrites packed workspace protocols to the local package version", () => {
    const packageJson = {
      dependencies: {
        "@afora/ai": "workspace:*",
        chalk: "5.6.2",
      },
    };

    expect(
      rewriteWorkspaceDependencyVersions(packageJson, [
        {
          name: "@afora/ai",
          version: "2026.7.1-beta.3",
          tarball: "/tmp/afora-ai.tgz",
        },
      ]),
    ).toBe(1);
    expect(packageJson.dependencies).toEqual({
      "@afora/ai": "2026.7.1-beta.3",
      chalk: "5.6.2",
    });
  });

  it("rejects package archives with an unconfigured workspace dependency", () => {
    const packageJson = {
      dependencies: {
        "@afora/normalization-core": "workspace:*",
      },
    };

    expect(() => rewriteWorkspaceDependencyVersions(packageJson, [])).toThrow(
      "package archive references unconfigured workspace dependency: @afora/normalization-core",
    );
  });

  it("installs a packed root with transitive local workspace dependencies", () => {
    const root = mkdtempSync(join(tmpdir(), "afora-ocm-adapter-test-"));
    try {
      const archiveRoot = join(root, "archive");
      const packagedRoot = join(archiveRoot, "package");
      const workspaceDir = join(root, "ai");
      const transitiveWorkspaceDir = join(root, "normalization-core");
      const installDir = join(root, "install");
      const rootArchive = join(root, "afora.tgz");
      mkdirSync(packagedRoot, { recursive: true });
      mkdirSync(workspaceDir, { recursive: true });
      mkdirSync(transitiveWorkspaceDir, { recursive: true });
      writeFileSync(
        join(packagedRoot, "package.json"),
        `${JSON.stringify({
          name: "afora",
          version: "1.0.0",
          dependencies: { "@afora/ai": "workspace:*" },
        })}\n`,
      );
      writeFileSync(
        join(workspaceDir, "package.json"),
        `${JSON.stringify({
          name: "@afora/ai",
          version: "1.0.0",
          main: "index.js",
          dependencies: { "@afora/normalization-core": "workspace:*" },
        })}\n`,
      );
      writeFileSync(join(workspaceDir, "index.js"), "export const ready = true;\n");
      writeFileSync(
        join(transitiveWorkspaceDir, "package.json"),
        `${JSON.stringify({
          name: "@afora/normalization-core",
          version: "1.0.0",
          main: "index.js",
        })}\n`,
      );
      writeFileSync(join(transitiveWorkspaceDir, "index.js"), "export const normalized = true;\n");
      execFileSync("tar", ["-czf", rootArchive, "-C", archiveRoot, "package"]);

      execFileSync(
        process.execPath,
        [
          adapterPath,
          "install",
          "--prefix",
          installDir,
          "--omit=dev",
          "--no-save",
          "--package-lock=false",
          rootArchive,
        ],
        {
          env: {
            ...process.env,
            AFORA_OCM_REAL_NPM_BIN: process.platform === "win32" ? "npm.cmd" : "npm",
            AFORA_OCM_WORKSPACE_DEPENDENCY_DIRS: [workspaceDir, transitiveWorkspaceDir].join(
              delimiter,
            ),
            npm_config_audit: "false",
            npm_config_cache: join(root, "npm-cache"),
            npm_config_fund: "false",
          },
          stdio: "pipe",
        },
      );

      expect(
        JSON.parse(readFileSync(join(installDir, "node_modules/afora/package.json"), "utf8"))
          .version,
      ).toBe("1.0.0");
      expect(
        JSON.parse(readFileSync(join(installDir, "node_modules/@afora/ai/package.json"), "utf8"))
          .version,
      ).toBe("1.0.0");
      expect(
        JSON.parse(
          readFileSync(
            join(installDir, "node_modules/@afora/normalization-core/package.json"),
            "utf8",
          ),
        ).version,
      ).toBe("1.0.0");
      expect(
        JSON.parse(readFileSync(join(installDir, "node_modules/@afora/ai/package.json"), "utf8"))
          .dependencies["@afora/normalization-core"],
      ).toBe("1.0.0");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
