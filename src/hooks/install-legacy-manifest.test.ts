// afora-compat: covers hook packs that declare themselves under the pre-rename manifest key.
//
// The two cases below have to move together. Widening only the hooks read would install a legacy
// pack and then classify it `hook-only`, silently dropping the extensions it declares; and
// `plugins-command-helpers.ts` swallows MISSING_AFORA_HOOKS, so the un-widened first case is
// invisible to a tenant rather than merely wrong.
//
// Lives in its own file rather than in install.test.ts, which is at its max-lines ceiling.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installHooksFromPath } from "./install.js";

const fixtureRoot = path.join(process.cwd(), ".tmp", `afora-hook-legacy-${randomUUID()}`);
let caseIndex = 0;

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = path.join(fixtureRoot, `case-${caseIndex++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLegacyHookPack(params: { extensions?: string[] }): string {
  const pkgDir = makeTempDir();
  const hookDir = path.join(pkgDir, "hooks", "one-hook");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, "HOOK.md"), "---\nname: one-hook\n---\n", "utf8");
  fs.writeFileSync(path.join(hookDir, "handler.ts"), "export default async () => {};\n");
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@afora/legacy-test-hooks",
      version: "0.0.1",
      openclaw: {
        hooks: ["./hooks/one-hook"],
        ...(params.extensions ? { extensions: params.extensions } : {}),
      },
    }),
    "utf8",
  );
  return pkgDir;
}

describe("installHooksFromPath legacy manifest key", () => {
  it("installs a hook pack that declares itself under the legacy manifest key", async () => {
    const result = await installHooksFromPath({
      path: writeLegacyHookPack({}),
      hooksDir: path.join(makeTempDir(), "hooks"),
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hooks).toEqual(["one-hook"]);
    expect(result.packageKind).toBe("hook-only");
  });

  it("classifies a legacy-keyed pack that also declares extensions as plugin-capable", async () => {
    const result = await installHooksFromPath({
      path: writeLegacyHookPack({ extensions: ["./dist/index.js"] }),
      hooksDir: path.join(makeTempDir(), "hooks"),
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.packageKind).toBe("plugin-capable");
  });
});
