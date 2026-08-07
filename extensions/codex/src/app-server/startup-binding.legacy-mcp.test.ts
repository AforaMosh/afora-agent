import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { rotateOversizedCodexAppServerStartupBinding } from "./startup-binding.js";

describe("Codex app-server startup binding legacy MCP preservation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-startup-legacy-mcp-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    {
      pressure: "byte" as const,
      marker: { userMcpServersFingerprint: "legacy-user-mcp" },
    },
    {
      pressure: "token" as const,
      marker: { userMcpServersFingerprint: "legacy-user-mcp" },
    },
    {
      pressure: "byte" as const,
      marker: { mcpServersFingerprint: "legacy-bundled-mcp" },
    },
    {
      pressure: "token" as const,
      marker: { mcpServersFingerprint: "legacy-bundled-mcp" },
    },
    {
      pressure: "byte" as const,
      marker: { legacyMcpRetirementThreadId: "thread-predecessor" },
    },
    {
      pressure: "token" as const,
      marker: { legacyMcpRetirementThreadId: "thread-predecessor" },
    },
  ])(
    "preserves $marker legacy configured MCP provenance before $pressure-pressure rotation",
    async ({ pressure, marker }) => {
      const markerName = Object.keys(marker)[0];
      const sessionFile = path.join(tempDir, `${pressure}-${markerName}-session.jsonl`);
      const workspaceDir = path.join(tempDir, "workspace");
      const agentDir = path.join(tempDir, "agent");
      const identity = {
        kind: "session" as const,
        agentId: "main",
        sessionId: sessionFile,
      };
      const bindingStore = createCodexTestBindingStore([
        {
          identity,
          binding: {
            threadId: "thread-existing",
            cwd: workspaceDir,
            model: "gpt-5.4-codex",
            modelProvider: "openai",
            ...marker,
          },
        },
      ]);
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });
      await fs.writeFile(
        path.join(path.dirname(sessionFile), "sessions.json"),
        JSON.stringify({
          "agent:main:session-1": {
            sessionFile,
            totalTokens: 999_999,
          },
        }),
      );
      const rolloutDir = path.join(agentDir, "codex-home", "sessions");
      await fs.mkdir(rolloutDir, { recursive: true });
      await fs.writeFile(
        path.join(rolloutDir, "rollout-thread-existing.jsonl"),
        pressure === "byte"
          ? "x".repeat(2_000)
          : `${JSON.stringify({
              payload: {
                type: "token_count",
                info: {
                  last_token_usage: { total_tokens: 241_198 },
                  model_context_window: 258_400,
                },
              },
            })}\n`,
      );

      const binding = await rotateOversizedCodexAppServerStartupBinding({
        binding: await bindingStore.read(identity),
        bindingStore,
        identity,
        sessionFile,
        agentDir,
        config:
          pressure === "byte"
            ? ({
                agents: {
                  defaults: { compaction: { maxActiveTranscriptBytes: "1b" } },
                },
              } as never)
            : undefined,
      });

      expect(binding).toMatchObject({
        threadId: "thread-existing",
        ...marker,
      });
      await expect(bindingStore.read(identity)).resolves.toMatchObject({
        threadId: "thread-existing",
        ...marker,
      });
    },
  );
});
