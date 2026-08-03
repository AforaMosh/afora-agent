import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { AgentsSchema } from "../config/zod-schema.agents.js";
import {
  isHeartbeatEnabledForAgent,
  resolveHeartbeatSummaryForAgent,
} from "./heartbeat-summary.js";

type HeartbeatSummaryCase = {
  readonly name: string;
  readonly config: OpenClawConfig;
  readonly agentId: string;
  readonly eligible: boolean;
  readonly expected: Pick<
    ReturnType<typeof resolveHeartbeatSummaryForAgent>,
    "enabled" | "every" | "everyMs"
  >;
};

describe("resolveHeartbeatSummaryForAgent", () => {
  it("accepts keyed agents and rejects the internal list projection in raw config", () => {
    const entries = { main: { default: true } };

    expect(AgentsSchema.safeParse({ entries }).success).toBe(true);
    const rejected = AgentsSchema.safeParse({
      entries,
      list: [{ id: "main", default: true }],
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues).toEqual([
      expect.objectContaining({
        code: "unrecognized_keys",
        keys: ["list"],
      }),
    ]);
  });

  const heartbeatSummaryCases: readonly HeartbeatSummaryCase[] = [
    {
      name: "uses the default cadence when heartbeat config is absent",
      config: {},
      agentId: "main",
      eligible: true,
      expected: { enabled: true, every: "30m", everyMs: 30 * 60_000 },
    },
    {
      name: "disables a zero global cadence while preserving agent eligibility",
      config: {
        agents: {
          defaults: { heartbeat: { every: "0m" } },
          entries: { main: { default: true }, ops: {} },
        },
      },
      agentId: "ops",
      eligible: true,
      expected: { enabled: false, every: "disabled", everyMs: null },
    },
    {
      name: "disables a zero per-agent cadence override",
      config: {
        agents: {
          defaults: { heartbeat: { every: "30m" } },
          entries: { main: { default: true, heartbeat: { every: "0m" } } },
        },
      },
      agentId: "main",
      eligible: true,
      expected: { enabled: false, every: "disabled", everyMs: null },
    },
    {
      name: "allows a positive per-agent cadence to override disabled defaults",
      config: {
        agents: {
          defaults: { heartbeat: { every: "0m" } },
          entries: { main: { default: true, heartbeat: { every: "15m" } } },
        },
      },
      agentId: "main",
      eligible: true,
      expected: { enabled: true, every: "15m", everyMs: 15 * 60_000 },
    },
    {
      name: "disables an agent excluded by explicit heartbeat eligibility",
      config: {
        agents: {
          defaults: { heartbeat: { every: "30m" } },
          entries: {
            main: { default: true },
            ops: { heartbeat: { every: "15m" } },
          },
        },
      },
      agentId: "main",
      eligible: false,
      expected: { enabled: false, every: "disabled", everyMs: null },
    },
    {
      name: "keeps global positive cadence enabled for every eligible agent",
      config: {
        agents: {
          defaults: { heartbeat: { every: "45m" } },
          entries: { main: { default: true }, ops: {} },
        },
      },
      agentId: "ops",
      eligible: true,
      expected: { enabled: true, every: "45m", everyMs: 45 * 60_000 },
    },
  ];

  it.each(heartbeatSummaryCases)("$name", ({ config, agentId, eligible, expected }) => {
    const summary = resolveHeartbeatSummaryForAgent(config, agentId);

    expect(isHeartbeatEnabledForAgent(config, agentId)).toBe(eligible);
    expect(summary).toMatchObject(expected);
    expect(summary.enabled).toBe(summary.everyMs !== null);
  });

  it("preserves per-agent prompt, target, and model metadata for a disabled cadence", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            prompt: "Default prompt",
            target: "none",
            model: "openai/gpt-5.6-luna",
          },
        },
        entries: {
          main: {
            default: true,
            heartbeat: {
              every: "0m",
              prompt: "  Agent-specific prompt  ",
              target: "last",
              model: "anthropic/sonnet-4.6",
            },
          },
        },
      },
    };

    expect(resolveHeartbeatSummaryForAgent(config, "main")).toMatchObject({
      enabled: false,
      every: "disabled",
      everyMs: null,
      prompt: "Agent-specific prompt",
      target: "last",
      model: "anthropic/sonnet-4.6",
      ackMaxChars: 300,
    });
  });
});
