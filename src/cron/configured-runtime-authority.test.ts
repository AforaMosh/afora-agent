import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredCronRuntimeAuthorityStatus } from "./configured-runtime-authority.js";
import type { CronJob } from "./types.js";

function config(params: { primary?: string; subagent?: string; gmail?: string }): OpenClawConfig {
  const primary = params.primary ?? "anthropic/claude-sonnet-4-5";
  return {
    agents: {
      defaults: {
        model: { primary },
        ...(params.subagent ? { subagents: { model: params.subagent } } : {}),
        models: {
          "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
        },
      },
    },
    ...(params.gmail ? { hooks: { gmail: { model: params.gmail } } } : {}),
  };
}

function job(payload: Partial<Extract<CronJob["payload"], { kind: "agentTurn" }>> = {}): CronJob {
  return {
    id: "legacy",
    name: "Legacy",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "run",
      toolsAllow: ["read"],
      toolsAllowIsDefault: true,
      ...payload,
    },
    state: {},
  };
}

describe("configured cron runtime authority status", () => {
  it("classifies only an incomplete current Codex primary route", () => {
    expect(
      resolveConfiguredCronRuntimeAuthorityStatus({
        cfg: config({ primary: "openai/gpt-5.5" }),
        job: job(),
        env: {},
      }),
    ).toBe("incomplete");
    expect(
      resolveConfiguredCronRuntimeAuthorityStatus({
        cfg: config({}),
        job: job(),
        env: {},
      }),
    ).toBeUndefined();
  });

  it("applies payload, Gmail, and subagent configured-route precedence", () => {
    expect(
      resolveConfiguredCronRuntimeAuthorityStatus({
        cfg: config({ primary: "openai/gpt-5.5" }),
        job: job({ model: "anthropic/claude-sonnet-4-5" }),
        env: {},
      }),
    ).toBeUndefined();
    expect(
      resolveConfiguredCronRuntimeAuthorityStatus({
        cfg: config({ gmail: "openai/gpt-5.5" }),
        job: job({ externalContentSource: "gmail" }),
        env: {},
      }),
    ).toBe("incomplete");
    expect(
      resolveConfiguredCronRuntimeAuthorityStatus({
        cfg: config({ subagent: "openai/gpt-5.5" }),
        job: job(),
        env: {},
      }),
    ).toBe("incomplete");
  });

  it("omits complete, explicit, and unresolvable jobs", () => {
    const complete = job();
    complete.scheduledRuntimeAuthority = {
      version: 1,
      runtime: "codex",
      openClawTools: ["read"],
      apps: [],
      userMcpServers: [],
      pluginMcpServers: [],
    };
    const explicit = job({ toolsAllowIsDefault: false });

    for (const candidate of [complete, explicit]) {
      expect(
        resolveConfiguredCronRuntimeAuthorityStatus({
          cfg: config({ primary: "openai/gpt-5.5" }),
          job: candidate,
          env: {},
        }),
      ).toBeUndefined();
    }
    expect(
      resolveConfiguredCronRuntimeAuthorityStatus({
        cfg: config({ primary: "openai/gpt-5.5" }),
        job: { ...job(), agentId: "missing" },
        env: {},
      }),
    ).toBeUndefined();
  });
});
