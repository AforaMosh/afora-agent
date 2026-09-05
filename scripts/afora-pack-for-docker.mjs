#!/usr/bin/env node
// afora: builds the tarball the friday-host image installs into /opt/fork.
//
// On the pre-debrand line this file existed to UNDO the branding: it rewrote
// package.json back to name "openclaw" with both bin names, because the packer only
// accepted an openclaw-<version>.tgz filename and the image resolved
// /opt/fork/bin/openclaw. None of that is true here. The manifest is already
// afora-agent with an `afora` bin and an `openclaw` bin kept as an alias (D3), and
// scripts/package-afora-for-docker.mjs already produces and validates an
// afora-<version>.tgz. So there is nothing left to shim, and rewriting the manifest
// would now make the packer REJECT its own output.
//
// The file stays because host/fork/MANIFEST.json names it as the build recipe and
// because the recipe belongs in the repo rather than in somebody's shell history. It
// is now a passthrough that pins the one flag the docker pack needs: the fork ships
// ahead of upstream's changelog.
//
// The host half is NOT done: the image must still resolve /opt/fork/bin/afora, and
// MANIFEST.json's md5 pin must move with it. That is DB-PACK, and it is atomic across
// both repos.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const result = spawnSync(
  process.execPath,
  [
    join(root, "scripts", "package-afora-for-docker.mjs"),
    "--allow-unreleased-changelog",
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: "inherit" },
);
process.exit(result.status ?? 1);
