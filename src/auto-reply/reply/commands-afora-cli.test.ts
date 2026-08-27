// Verifies chat-facing CLI snippets execute the Afora CLI even from harness-hosted gateways.
import { describe, expect, it } from "vitest";
import {
  buildCurrentAforaCliArgv,
  buildCurrentAforaCliCommand,
  buildCurrentAforaCliExecEnv,
} from "./commands-afora-cli.js";

describe("buildCurrentAforaCliArgv", () => {
  it("delegates launch policy while keeping shell rendering local", () => {
    const args = ["sessions", "export-trajectory"];
    const argv = buildCurrentAforaCliArgv(args);
    expect(argv.at(-2)).toBe("sessions");
    expect(argv.at(-1)).toBe("export-trajectory");
    expect(buildCurrentAforaCliCommand(args)).toBe(argv.map((value) => `'${value}'`).join(" "));
  });

  it("clears inherited Vitest runner environment for CLI child processes", () => {
    expect(
      buildCurrentAforaCliExecEnv({
        PATH: "/usr/bin",
        VITEST: "true",
        VITEST_POOL_ID: "pool",
        AFORA_VITEST_MAX_WORKERS: "1",
      }),
    ).toEqual({
      VITEST: "",
      VITEST_POOL_ID: "",
      AFORA_VITEST_MAX_WORKERS: "",
    });
  });
});
