import type { AforaConfig } from "../config/types.afora.js";
import { measureDiagnosticsTimelineSpan } from "../infra/diagnostics-timeline.js";

type AgentStartupTimingOptions = {
  config?: AforaConfig;
  env?: NodeJS.ProcessEnv;
};

/** Measures local agent startup work before the canonical provider-preparation spans begin. */
export function measureAgentStartup<T>(
  stage: string,
  run: () => Promise<T> | T,
  options: AgentStartupTimingOptions = {},
): Promise<T> {
  return measureDiagnosticsTimelineSpan("agent.startup", run, {
    config: options.config,
    env: options.env,
    phase: "agent.startup",
    attributes: { stage },
  });
}
