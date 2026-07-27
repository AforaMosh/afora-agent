// Test-only full-config writer for fixtures that do not exercise write intent selection.
import type { ConfigWriteOptions, ConfigWriteResult } from "../../src/config/io.types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

export async function writeConfigReplacementForTest(
  config: OpenClawConfig,
  options: ConfigWriteOptions = {},
): Promise<ConfigWriteResult> {
  const { writeConfigFile } = await import("../../src/config/io.js");
  return await writeConfigFile(
    { kind: "replace", config, allowAgentRosterRemovals: true },
    options,
  );
}
