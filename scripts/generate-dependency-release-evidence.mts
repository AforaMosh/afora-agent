#!/usr/bin/env node

import process from "node:process";
import { main } from "./generate-dependency-release-evidence.mjs";

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
