import { describe, expect, it } from "vitest";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { assertSupportedTurn } from "./worker-turn-payload.js";

describe("assertSupportedTurn", () => {
  it("accepts scheduled authority for the worker launch envelope", () => {
    expect(
      assertSupportedTurn({
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "run",
        timeoutMs: 1_000,
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        config: {
          agents: {
            defaults: {
              models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
            },
          },
        },
        toolsAllow: ["write"],
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "default",
        },
        scheduledNativePolicy: { version: 1, mode: "disabled" },
      } as SessionPlacementTurnParams),
    ).toEqual({ provider: "openai", model: "gpt-5.4" });
  });

  it("rejects inherited native authority and reachable MCP with recovery guidance", () => {
    const base = {
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "run",
      timeoutMs: 1_000,
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
    } as SessionPlacementTurnParams;

    expect(() =>
      assertSupportedTurn({
        ...base,
        scheduledNativePolicy: { version: 1, mode: "inherit" },
      }),
    ).toThrow(/cannot currently preserve.*native tool authority.*sessions\.reclaim/is);
    expect(() =>
      assertSupportedTurn({
        ...base,
        config: {
          ...base.config,
          mcp: { servers: { docs: { command: "docs" } } },
        },
        scheduledNativePolicy: { version: 1, mode: "disabled" },
      }),
    ).toThrow(/cannot currently preserve.*MCP tool authority.*sessions\.reclaim/is);
  });

  it("accepts a finite cap that cannot reach configured MCP", () => {
    const turn = {
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "run",
      timeoutMs: 1_000,
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      config: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
        mcp: { servers: { docs: { command: "docs" } } },
      },
      toolsAllow: ["read"],
      scheduledNativePolicy: { version: 1, mode: "disabled" },
    } as SessionPlacementTurnParams;

    expect(assertSupportedTurn(turn)).toEqual({ provider: "openai", model: "gpt-5.4" });
  });
});
