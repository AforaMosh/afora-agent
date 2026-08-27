// Tokenjuice tests cover index plugin behavior.
import fs from "node:fs";
import { createAgentToolResultMiddlewareRunner } from "afora-agent/plugin-sdk/agent-harness";
import { createTestPluginApi } from "afora-agent/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { tokenjuiceFactory, createTokenjuiceAforaEmbeddedExtension } = vi.hoisted(() => {
  const tokenjuiceFactoryLocal = vi.fn();
  const createTokenjuiceAforaEmbeddedExtensionLocal = vi.fn(() => tokenjuiceFactoryLocal);
  return {
    tokenjuiceFactory: tokenjuiceFactoryLocal,
    createTokenjuiceAforaEmbeddedExtension: createTokenjuiceAforaEmbeddedExtensionLocal,
  };
});

vi.mock("./runtime-api.js", () => ({
  createTokenjuiceAforaEmbeddedExtension,
}));

import plugin from "./index.js";
import { createTokenjuiceAgentToolResultMiddleware } from "./tool-result-middleware.js";

describe("tokenjuice plugin", () => {
  beforeEach(() => {
    createTokenjuiceAforaEmbeddedExtension.mockClear();
    tokenjuiceFactory.mockClear();
  });

  it("is opt-in by default", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./afora.plugin.json", import.meta.url), "utf8"),
    ) as { enabledByDefault?: unknown };

    expect(manifest.enabledByDefault).toBeUndefined();
  });

  it("registers tokenjuice tool result middleware for Afora and Codex runtimes", () => {
    const registerAgentToolResultMiddleware = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "tokenjuice",
        name: "tokenjuice",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerAgentToolResultMiddleware,
      }),
    );

    expect(createTokenjuiceAforaEmbeddedExtension).toHaveBeenCalledTimes(1);
    expect(tokenjuiceFactory).toHaveBeenCalledTimes(1);
    const registration = registerAgentToolResultMiddleware.mock.calls[0];
    expect(typeof registration?.[0]).toBe("function");
    expect(registration?.[1]).toEqual({ runtimes: ["afora", "codex"] });
  });

  it("synthesises exec status when bash provides metadata-only details", async () => {
    let received:
      | {
          details: unknown;
        }
      | undefined;
    tokenjuiceFactory.mockImplementationOnce(
      (api: { on: (event: string, handler: unknown) => void }) => {
        api.on("tool_result", async (event: typeof received) => {
          received = event;
        });
      },
    );

    const middleware = createTokenjuiceAgentToolResultMiddleware();
    await middleware(
      {
        toolCallId: "tool-call-tokenjuice-bash-meta",
        toolName: "bash",
        args: { command: "cat /tmp/out.txt", workdir: "/tmp/afora-tokenjuice-test" },
        result: {
          content: [{ type: "text", text: "file contents\n" }],
          details: {
            truncation: { reason: "max_bytes" },
            fullOutputPath: "/tmp/out.txt",
          },
        },
        isError: false,
      },
      { runtime: "afora" },
    );

    expect(received?.details).toMatchObject({
      status: "completed",
      exitCode: 0,
      truncation: { reason: "max_bytes" },
      fullOutputPath: "/tmp/out.txt",
    });
    expect(received?.details).not.toHaveProperty("aggregated");
  });

  it("passes through status metadata without duplicate aggregated output", async () => {
    let received:
      | {
          details: unknown;
        }
      | undefined;
    tokenjuiceFactory.mockImplementationOnce(
      (api: { on: (event: string, handler: unknown) => void }) => {
        api.on("tool_result", async (event: typeof received) => {
          received = event;
        });
      },
    );

    const existingDetails = {
      status: "completed",
      aggregated: "pre-built output",
      exitCode: 0,
      cwd: "/existing/cwd",
    };

    const middleware = createTokenjuiceAgentToolResultMiddleware();
    await middleware(
      {
        toolCallId: "tool-call-tokenjuice-bash-existing",
        toolName: "bash",
        args: { command: "echo hi", workdir: "/tmp" },
        result: {
          content: [{ type: "text", text: "hi\n" }],
          details: existingDetails,
        },
        isError: false,
      },
      { runtime: "afora" },
    );

    expect(received?.details).toEqual({
      status: "completed",
      exitCode: 0,
      cwd: "/existing/cwd",
    });
    expect(received?.details).not.toBe(existingDetails);
  });

  it("keeps compacted exec results below the middleware details limit", async () => {
    tokenjuiceFactory.mockImplementationOnce(
      (api: { on: (event: string, handler: unknown) => void }) => {
        api.on("tool_result", async (event: { details: Record<string, unknown> }) => ({
          content: [{ type: "text", text: "compacted" }],
          details: { ...event.details, tokenjuice: { compacted: true } },
        }));
      },
    );

    const runner = createAgentToolResultMiddlewareRunner({ runtime: "afora" }, [
      createTokenjuiceAgentToolResultMiddleware(),
    ]);
    const result = await runner.applyToolResultMiddleware({
      toolCallId: "tool-call-tokenjuice-large",
      toolName: "exec",
      args: { command: "seq 1 30000" },
      result: {
        content: [{ type: "text", text: "x".repeat(120_000) }],
        details: undefined,
      },
    });

    expect(result.content).toEqual([{ type: "text", text: "compacted" }]);
    expect(result.details).toEqual({
      status: "completed",
      exitCode: 0,
      tokenjuice: { compacted: true },
    });
  });

  it.each([
    ["exit code", { exitCode: 7 }, "failed", 7],
    ["success flag", { success: false }, "failed", 1],
    ["ok flag", { ok: false }, "failed", 1],
    ["timeout flag", { timedOut: true }, "failed", 1],
    ["error value", { error: "command failed" }, "failed", 1],
    ["successful exit code", { exitCode: 0 }, "completed", 0],
    ["successful flag", { success: true }, "completed", 0],
  ])(
    "adds a canonical status while preserving bash details with a %s",
    async (_label, existingDetails, status, exitCode) => {
      let received:
        | {
            details: unknown;
          }
        | undefined;
      tokenjuiceFactory.mockImplementationOnce(
        (api: { on: (event: string, handler: unknown) => void }) => {
          api.on("tool_result", async (event: typeof received) => {
            received = event;
          });
        },
      );

      const middleware = createTokenjuiceAgentToolResultMiddleware();
      await middleware(
        {
          toolCallId: "tool-call-tokenjuice-bash-terminal",
          toolName: "bash",
          args: { command: "exit 7", workdir: "/tmp" },
          result: {
            content: [{ type: "text", text: "failed\n" }],
            details: existingDetails,
          },
          isError: false,
        },
        { runtime: "afora" },
      );

      expect(received?.details).toMatchObject({
        ...existingDetails,
        status,
        exitCode,
      });
    },
  );

  it("normalizes bash results without details before passing them to tokenjuice", async () => {
    let received:
      | {
          toolName: string;
          input: Record<string, unknown>;
          content: unknown;
          details: unknown;
          isError?: boolean;
        }
      | undefined;
    tokenjuiceFactory.mockImplementationOnce(
      (api: { on: (event: string, handler: unknown) => void }) => {
        api.on("tool_result", async (event: typeof received) => {
          received = event;
          return { content: [{ type: "text", text: "compacted" }] };
        });
      },
    );

    const middleware = createTokenjuiceAgentToolResultMiddleware();
    const result = await middleware(
      {
        toolCallId: "tool-call-tokenjuice-bash",
        toolName: "bash",
        args: { command: "printf 'hello\\n'", workdir: "/tmp/afora-tokenjuice-test" },
        result: { content: [{ type: "text", text: "hello\n" }], details: undefined },
        isError: false,
      },
      { runtime: "afora" },
    );

    expect(received?.toolName).toBe("bash");
    expect(received?.details).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect(received?.details).not.toHaveProperty("cwd");
    expect(received?.details).not.toHaveProperty("aggregated");
    expect(result?.result.content).toEqual([{ type: "text", text: "compacted" }]);
  });
});
