// Imessage plugin module implements runtime behavior.
import { createNonExitingRuntime, type RuntimeEnv } from "afora-agent/plugin-sdk/runtime-env";
import type { MonitorIMessageOpts } from "./types.js";

export function resolveRuntime(opts: MonitorIMessageOpts): RuntimeEnv {
  return opts.runtime ?? createNonExitingRuntime();
}
