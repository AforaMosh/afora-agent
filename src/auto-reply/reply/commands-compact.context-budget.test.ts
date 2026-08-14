// /compact context-budget resolution: runtime config, agent caps, legacy aliases.
// Split from commands-compact.test.ts, which sits at the max-lines cap.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentDirMock,
  resolveSessionAgentIdMock,
} from "./commands-agent-scope.test-support.js";
import {
  buildCompactParams,
  requireCompactEmbeddedAgentSessionCall,
} from "./commands-compact.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

vi.mock("./commands-compact.runtime.js", () => ({
  abortEmbeddedAgentRun: vi.fn(),
  compactEmbeddedAgentSession: vi.fn(),
  enqueueSystemEvent: vi.fn(),
  formatContextUsageShort: vi.fn(() => "Context 12.1k"),
  formatTokenCount: vi.fn((value: number) => `${value}`),
  incrementCompactionCount: vi.fn(),
  isCurrentSessionEntry: vi.fn(() => true),
  isEmbeddedAgentRunAbortableForCompaction: vi.fn().mockReturnValue(false),
  resolveFreshSessionTotalTokens: vi.fn(() => 12_345),
  resolveSessionFilePathOptions: vi.fn(() => ({})),
  waitForEmbeddedAgentRunEnd: vi.fn().mockResolvedValue(true),
}));

const {
  compactEmbeddedAgentSession,
  formatContextUsageShort,
  incrementCompactionCount,
  isCurrentSessionEntry,
} = await import("./commands-compact.runtime.js");
const { handleCompactCommand } = await import("./commands-compact.js");

describe("handleCompactCommand context budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(incrementCompactionCount).mockResolvedValue(1);
    vi.mocked(isCurrentSessionEntry).mockReturnValue(true);
    resolveAgentDirMock.mockImplementation(
      (_cfg: unknown, agentId: string) => `/tmp/workspace/.openclaw/agents/${agentId}/agent`,
    );
    resolveSessionAgentIdMock.mockReturnValue("main");
  });

  it("resolves /compact context budget from the active Codex runtime config instead of stale session metadata", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "compacted",
        firstKeptEntryId: "first-kept",
        tokensBefore: 199_000,
        tokensAfter: 56_000,
      },
    });

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": {
                  agentRuntime: { id: "codex" },
                },
              },
            },
          },
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
          models: {
            providers: {
              openai: {
                models: [{ id: "gpt-5.5", contextWindow: 258_000 }],
              },
            },
          },
        } as unknown as OpenClawConfig),
        provider: "openai",
        model: "openai/gpt-5.5",
        contextTokens: 0,
        sessionEntry: {
          sessionId: "live-session",
          updatedAt: Date.now(),
          contextTokens: 400_000,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(requireCompactEmbeddedAgentSessionCall().contextTokenBudget).toBe(258_000);
    expect(vi.mocked(formatContextUsageShort)).toHaveBeenLastCalledWith(56_000, 258_000);
  });

  it.each([
    { globalCap: undefined, agentCap: undefined, expectedBudget: 1_000_000 },
    { globalCap: 372_000, agentCap: 120_000, expectedBudget: 120_000 },
    { globalCap: 120_000, agentCap: 372_000, expectedBudget: 372_000 },
  ])("respects the target agent context cap for /compact (#117470)", async (testCase) => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "compacted",
        firstKeptEntryId: "first-kept",
        tokensBefore: 134_930,
        tokensAfter: 56_000,
      },
    });

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          agents: {
            ...(testCase.globalCap === undefined
              ? {}
              : { defaults: { contextTokens: testCase.globalCap } }),
            ...(testCase.agentCap === undefined
              ? {}
              : { list: [{ id: "main", contextTokens: testCase.agentCap }] }),
          },
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        provider: "claude-cli",
        model: "claude-fable-5",
        contextTokens: testCase.globalCap ?? 0,
        sessionEntry: {
          sessionId: "fable-session",
          updatedAt: Date.now(),
          contextTokens: 1_000_000,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(requireCompactEmbeddedAgentSessionCall().contextTokenBudget).toBe(
      testCase.expectedBudget,
    );
  });

  it("retains persisted context when an unknown custom model is stored as a legacy alias", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "already compacted",
    });

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          agents: {
            defaults: {
              models: { "custom/actual-model": { alias: "legacy-fast-model" } },
            },
          },
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        provider: "custom",
        model: "actual-model",
        contextTokens: 0,
        sessionEntry: {
          sessionId: "legacy-model-session",
          updatedAt: Date.now(),
          providerOverride: "custom",
          modelOverride: "legacy-fast-model",
          modelOverrideSource: "user",
          contextTokens: 777_777,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(requireCompactEmbeddedAgentSessionCall().contextTokenBudget).toBe(777_777);
  });
});
