#!/usr/bin/env node

import process from "node:process";

type EvidenceMain = (argv?: string[]) => Promise<number>;
type EvidenceModule = { main: EvidenceMain };

const legacyModulePath: string = "./generate-dependency-release-evidence.mjs";

async function run() {
  const { main } = (await import(legacyModulePath)) as EvidenceModule;
  return main();
}

run().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
