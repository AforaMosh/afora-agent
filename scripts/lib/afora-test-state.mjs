import { runTsxCliShim } from "./tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  implementation: "./afora-test-state.mts",
});
