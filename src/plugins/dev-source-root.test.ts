// Covers the AFORA_DEV_SOURCE_ROOT validator, which had no test of its own while deciding
// whether a developer's checkout is adopted as the bundled-plugin source at all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAforaDevSourceRoot } from "./dev-source-root.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function makeCheckout(packageName: unknown): string {
  // realpath first: on macOS os.tmpdir() is a /var -> /private/var symlink and the validator
  // compares against safeRealpathSync's canonical answer.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afora-dev-source-")));
  tempDirs.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: packageName }));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "extensions"));
  return root;
}

describe("resolveAforaDevSourceRoot", () => {
  // The env var can only be pointed at a source checkout, whose manifest is "afora-agent".
  // "afora" is what an npm install of the published package presents, and "openclaw" is a
  // checkout that predates the rename; all three are our own tree.
  it.each(["afora-agent", "afora", "openclaw"])("adopts a checkout named %s", (packageName) => {
    const root = makeCheckout(packageName);
    expect(resolveAforaDevSourceRoot({ AFORA_DEV_SOURCE_ROOT: root })).toBe(root);
  });

  // Membership, not a prefix: adopting a neighbouring project would make its extensions/ shadow
  // every bundled plugin id in the running process.
  it.each(["afora-fork", "afora-agent-extra", "not-afora", "", 42, null])(
    "rejects a checkout named %s",
    (packageName) => {
      const root = makeCheckout(packageName);
      expect(resolveAforaDevSourceRoot({ AFORA_DEV_SOURCE_ROOT: root })).toBeNull();
    },
  );

  it("rejects an unset or blank env var without touching the filesystem", () => {
    expect(resolveAforaDevSourceRoot({})).toBeNull();
    expect(resolveAforaDevSourceRoot({ AFORA_DEV_SOURCE_ROOT: "   " })).toBeNull();
  });

  it.each(["src", "extensions"])("rejects a core-named root that is missing %s/", (missingDir) => {
    const root = makeCheckout("afora-agent");
    fs.rmSync(path.join(root, missingDir), { recursive: true });
    expect(resolveAforaDevSourceRoot({ AFORA_DEV_SOURCE_ROOT: root })).toBeNull();
  });
});
