// Package git fixture tests cover package-derived Docker git install fixtures.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

describe("package git fixture", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("stages bundled ai runtime as a local file dependency", async () => {
    const root = tempDirs.make("afora-package-git-fixture-");
    writeFileSync(path.join(root, ".gitignore"), "dist/\n");
    mkdirSync(path.join(root, "node_modules", "@afora", "ai"), { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify(
        {
          dependencies: { "@afora/ai": "2026.6.11", chalk: "5.6.2" },
          bundleDependencies: ["@afora/ai", "chalk"],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      path.join(root, "node_modules", "@afora", "ai", "package.json"),
      `${JSON.stringify({
        name: "@afora/ai",
        version: "2026.6.11",
        type: "module",
        main: "./dist/index.mjs",
        exports: { ".": "./dist/index.mjs" },
        devDependencies: { "@afora/normalization-core": "0.0.0-private" },
      })}\n`,
    );

    const result = spawnSync(
      process.execPath,
      ["scripts/e2e/lib/package-git-fixture.mjs", "prepare", root],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/u)).toEqual(
      expect.arrayContaining(["dist/", "node_modules", "**/node_modules/", "pnpm-lock.yaml"]),
    );
    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(packageJson.dependencies["@afora/ai"]).toBe("file:.afora-fixture/packages/ai");
    expect(packageJson.bundleDependencies).toEqual(["chalk"]);
    const relocatedAiPackage = JSON.parse(
      readFileSync(path.join(root, ".afora-fixture", "packages", "ai", "package.json"), "utf8"),
    );
    expect(relocatedAiPackage).toMatchObject({
      name: "@afora/ai",
      version: "2026.6.11",
      type: "module",
      main: "./dist/index.mjs",
      exports: { ".": "./dist/index.mjs" },
    });
    expect(relocatedAiPackage).not.toHaveProperty("devDependencies");

    mkdirSync(path.join(root, "node_modules", "chalk"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "chalk", "package.json"), "{}\n");
    mkdirSync(path.join(root, ".afora-fixture", "packages", "ai", "node_modules", "zod"), {
      recursive: true,
    });
    writeFileSync(
      path.join(root, ".afora-fixture", "packages", "ai", "node_modules", "zod", "package.json"),
      "{}\n",
    );
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect(spawnSync("git", ["init", "-q", root], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("git", ["-C", root, "add", "-A"], { encoding: "utf8" }).status).toBe(0);
    const staged = spawnSync("git", ["-C", root, "diff", "--cached", "--name-only"], {
      encoding: "utf8",
    });
    expect(staged.status).toBe(0);
    expect(staged.stdout).not.toContain("node_modules");
    expect(staged.stdout).not.toContain("pnpm-lock.yaml");
  });
});
