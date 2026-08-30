#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// afora: builds the tarball the friday-host image installs into /opt/fork.
//
// The branding commit renamed the package to `afora-agent` with a single `afora`
// bin, but package-openclaw-for-docker only accepts an `openclaw-<version>.tgz`
// filename and the host image resolves /opt/fork/bin/openclaw. So the docker
// artifact keeps the upstream package name and ships both bin names. This shims
// package.json for the pack and always puts it back, so the recipe lives here
// instead of in somebody's shell history.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "package.json");
const original = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(original);
const shimmed = {
  ...manifest,
  name: "openclaw",
  bin: { openclaw: "openclaw.mjs", afora: "openclaw.mjs" },
};

writeFileSync(manifestPath, `${JSON.stringify(shimmed, null, 2)}\n`, "utf8");
try {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "scripts", "package-openclaw-for-docker.mjs"),
      "--allow-unreleased-changelog",
      ...process.argv.slice(2),
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
} finally {
  writeFileSync(manifestPath, original, "utf8");
}
