import { describe, expect, test } from "vitest";
import { formatEmbeddedAgentExecutionPhase } from "./execution-phase.js";

describe("formatEmbeddedAgentExecutionPhase", () => {
  test.each([
    ["session_materialization_started", "session-materialization-started"],
    ["session_materialized", "session-materialized"],
    ["session_prepared", "session-prepared"],
  ] as const)("formats the %s diagnostic phase", (phase, expected) => {
    expect(formatEmbeddedAgentExecutionPhase(phase)).toBe(expected);
  });
});
