// Verifies Afora tool registration, availability, and construction policy.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AforaConfig } from "../config/config.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import { withEnv } from "../test-utils/env.js";
import { isToolWrappedWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { applyToolAvailabilityDescriptions } from "./agent-tools.deferred-followup.js";
import { createAforaCodingTools } from "./agent-tools.js";
import { resolveCoreToolFactoryFamily } from "./core-tool-factory-descriptors.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "./cron-creator-authority-context.js";
import { createAforaTools } from "./afora-tools.js";
import {
  collectPresentAforaTools,
  shouldIncludeAskUserToolForAforaTools,
  shouldIncludeProgressCardToolForAforaTools,
} from "./afora-tools.registration.js";
import { textResult, type AnyAgentTool } from "./tools/common.js";
import { createPdfTool } from "./tools/pdf-tool.js";

vi.mock("./afora-plugin-tools.js", () => ({
  resolveAforaPluginToolsForOptions: () => [],
}));

type ProgressCardGatingParams = Parameters<typeof shouldIncludeProgressCardToolForAforaTools>[0];
type CreateAforaToolsOptions = NonNullable<Parameters<typeof createAforaTools>[0]>;

function withDefaultRoster(config: AforaConfig | undefined): AforaConfig {
  return {
    ...config,
    agents: config?.agents ?? { entries: { main: { default: true } } },
  };
}

function expectProgressCardEnabled(params: ProgressCardGatingParams, expected: boolean): void {
  expect(
    shouldIncludeProgressCardToolForAforaTools({
      ...params,
      config: withDefaultRoster(params.config),
    }),
  ).toBe(expected);
}

function toolNames(tools: ReturnType<typeof createAforaTools>): string[] {
  return tools.map((tool) => tool.name);
}

function createFastToolNames(options: CreateAforaToolsOptions): string[] {
  // Disable unrelated dynamic surfaces so registration assertions stay deterministic.
  return toolNames(
    createTestAforaTools({
      disableMessageTool: true,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
      ...options,
    }),
  );
}

function createTestAforaTools(options: CreateAforaToolsOptions = {}) {
  return createAforaTools({
    ...options,
    config: withDefaultRoster(options.config),
  });
}

function expectToolNamed(
  tools: ReturnType<typeof createAforaTools>,
  name: string,
): ReturnType<typeof createAforaTools>[number] {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected tool ${name} to be registered`);
  }
  return tool;
}

describe("afora-tools progress_card gating", () => {
  afterEach(() => {
    setEmbeddedMode(false);
  });

  it("keeps concrete Afora tool names in the factory descriptor catalog", () => {
    const emittedNames = createFastToolNames({
      agentSessionKey: "agent:main:main",
      config: {
        tools: { allow: ["update_plan"] },
        transcripts: { enabled: true },
      } as AforaConfig,
      cwd: "/repo",
      enableHeartbeatTool: true,
      taskSuggestionDeliveryMode: "gateway",
    });

    expect(
      emittedNames.filter((name) => resolveCoreToolFactoryFamily(name) !== "afora"),
    ).toEqual([]);
  });

  it("enables progress_card by default", () => {
    expectProgressCardEnabled({ config: {} as AforaConfig }, true);
  });

  it("exposes progress_card from default tool construction for every embedded model", () => {
    const defaultTools = createFastToolNames({
      config: {} as AforaConfig,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });

    expect(defaultTools).toContain("progress_card");
    expect(defaultTools).not.toContain("ask_user");
  });

  it("keeps ask_user on primary sessions and excludes spawned worker sessions", () => {
    expect(shouldIncludeAskUserToolForAforaTools({})).toBe(false);
    expect(shouldIncludeAskUserToolForAforaTools({ agentSessionKey: "agent:main:main" })).toBe(
      true,
    );
    expect(
      shouldIncludeAskUserToolForAforaTools({
        agentSessionKey: "agent:main:subagent:worker",
      }),
    ).toBe(false);
    expect(
      shouldIncludeAskUserToolForAforaTools({ agentSessionKey: "agent:main:acp:worker" }),
    ).toBe(false);
    // ask_user must not depend on the TUI embedded-host flag; normal gateway
    // runs are the primary consumer.
    expect(
      createFastToolNames({
        config: {} as AforaConfig,
        runSessionKey: "agent:main:non-embedded",
      }),
    ).toContain("ask_user");
    setEmbeddedMode(true);

    expect(
      createFastToolNames({
        config: {} as AforaConfig,
        agentSessionKey: "agent:main:subagent:worker",
      }),
    ).not.toContain("ask_user");
    expect(
      createFastToolNames({
        config: {} as AforaConfig,
        runSessionKey: "agent:main:run",
      }),
    ).toContain("ask_user");
  });

  it("wraps constructed tools with before-tool-call hooks by default", () => {
    const tools = createTestAforaTools({
      config: {} as AforaConfig,
      disablePluginTools: true,
    });
    const unwrappedTools = createTestAforaTools({
      config: {} as AforaConfig,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
    });

    expect(isToolWrappedWithBeforeToolCallHook(expectToolNamed(tools, "sessions_list"))).toBe(true);
    expect(
      isToolWrappedWithBeforeToolCallHook(expectToolNamed(unwrappedTools, "sessions_list")),
    ).toBe(false);
  });

  it("injects reachable Control UI session links into all session lookup tools", () => {
    const tools = createTestAforaTools({
      config: {
        gateway: {
          publicOrigin: "http://127.0.0.1:18789",
          controlUi: { basePath: " /control/// " },
        },
      } as AforaConfig,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
    });
    const guidance =
      "When pointing the user at a session, cite its Control UI URL: main session -> `http://127.0.0.1:18789/control/chat/<agentId>`; any other display session key -> `http://127.0.0.1:18789/control/chat/<agentId>/~key/` + key minus `agent:<agentId>:`, with `:` replaced by `/`.";

    for (const name of ["sessions_list", "sessions_history", "sessions_search"]) {
      expect(expectToolNamed(tools, name).description).toContain(guidance);
    }
  });

  it("keeps message tool in embedded message-tool-only completions", () => {
    setEmbeddedMode(true);
    const tools = createTestAforaTools({
      config: {} as AforaConfig,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(toolNames(tools)).toContain("message");
  });

  it("exposes delegation only to regular unsandboxed gateway agents", () => {
    const regular = createFastToolNames({
      config: {} as AforaConfig,
      agentSessionKey: "agent:main:main",
    });
    const sandboxed = createFastToolNames({
      config: {} as AforaConfig,
      agentSessionKey: "agent:main:main",
      sandboxed: true,
    });
    const system = createFastToolNames({
      config: {} as AforaConfig,
      agentSessionKey: "agent:afora:main",
    });
    setEmbeddedMode(true);
    const embedded = createFastToolNames({
      config: {} as AforaConfig,
      agentSessionKey: "agent:main:main",
    });

    expect(regular).toContain("afora");
    expect(sandboxed).not.toContain("afora");
    expect(system).not.toContain("afora");
    expect(embedded).not.toContain("afora");
  });

  it("registers transcripts for an active local operator with an explicit global opt-out", () => {
    const capability = createCronCreatorAuthorityCapability("run-local", { kind: "local" })!;
    const { defaultTools, disabledTools } = runWithCronCreatorAuthorityCapability(
      capability,
      () => ({
        defaultTools: createFastToolNames({
          config: {} as AforaConfig,
          runId: "run-local",
        }),
        disabledTools: createFastToolNames({
          config: { transcripts: { enabled: false } } as AforaConfig,
          runId: "run-local",
        }),
      }),
    );

    expect(defaultTools).toContain("transcripts");
    expect(disabledTools).not.toContain("transcripts");
  });

  it("registers task suggestions only for sessions with an actionable gateway sink", () => {
    const withoutSession = createFastToolNames({
      config: {} as AforaConfig,
      cwd: "/repo",
      taskSuggestionDeliveryMode: "gateway",
    });
    const withoutSink = createFastToolNames({
      config: {} as AforaConfig,
      agentSessionKey: "agent:main:main",
      cwd: "/repo",
    });
    const withSink = createFastToolNames({
      config: {} as AforaConfig,
      agentSessionKey: "agent:main:main",
      cwd: "/repo",
      taskSuggestionDeliveryMode: "gateway",
    });

    expect(withoutSession).not.toContain("suggest_task");
    expect(withoutSession).not.toContain("dismiss_task");
    expect(withoutSink).not.toContain("suggest_task");
    expect(withoutSink).not.toContain("dismiss_task");
    expect(withSink).toEqual(expect.arrayContaining(["suggest_task", "dismiss_task"]));
  });

  it("keeps explicitly allowed message tool in embedded completions", () => {
    setEmbeddedMode(true);
    const fromRuntimeAllowlist = createTestAforaTools({
      config: {} as AforaConfig,
      disablePluginTools: true,
      pluginToolAllowlist: ["message"],
      wrapBeforeToolCallHook: false,
    });
    const fromGlobalAlsoAllow = createTestAforaTools({
      config: { tools: { profile: "minimal", alsoAllow: ["message"] } } as AforaConfig,
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
    });
    const denied = createTestAforaTools({
      config: {} as AforaConfig,
      disablePluginTools: true,
      pluginToolAllowlist: ["message"],
      pluginToolDenylist: ["message"],
      wrapBeforeToolCallHook: false,
    });

    expect(toolNames(fromRuntimeAllowlist)).toContain("message");
    expect(toolNames(fromGlobalAlsoAllow)).toContain("message");
    expect(toolNames(denied)).not.toContain("message");
  });

  it("keeps subagent spawn available for trusted embedded gateway-bound runs", () => {
    setEmbeddedMode(true);
    const defaultTools = createFastToolNames({
      config: {} as AforaConfig,
    });
    const gatewayBoundTools = createFastToolNames({
      config: {} as AforaConfig,
      allowGatewaySubagentBinding: true,
    });

    expect(defaultTools).not.toContain("sessions_spawn");
    expect(defaultTools).not.toContain("sessions_send");
    expect(gatewayBoundTools).toContain("sessions_spawn");
    expect(gatewayBoundTools).not.toContain("sessions_send");
  });

  it("advertises sessions_spawn from agents_list only when spawn is available", () => {
    setEmbeddedMode(true);
    const createTools = (allowGatewaySubagentBinding: boolean) =>
      applyToolAvailabilityDescriptions(
        createTestAforaTools({
          allowGatewaySubagentBinding,
          config: {} as AforaConfig,
          disableMessageTool: true,
          disablePluginTools: true,
          wrapBeforeToolCallHook: false,
        }),
      );
    const withoutSpawn = createTools(false);
    const withSpawn = createTools(true);

    expect(toolNames(withoutSpawn)).not.toContain("sessions_spawn");
    expect(expectToolNamed(withoutSpawn, "agents_list").description).not.toContain(
      "sessions_spawn",
    );
    expect(toolNames(withSpawn)).toContain("sessions_spawn");
    expect(expectToolNamed(withSpawn, "agents_list").description).toContain("sessions_spawn");
  });

  it("registers progress_card when explicitly enabled", () => {
    const config = { tools: { updatePlan: true } } as AforaConfig;

    expectProgressCardEnabled({ config }, true);
  });

  it("maps the shipped update_plan allowlist name to progress_card", () => {
    const tools = createFastToolNames({
      config: {} as AforaConfig,
      pluginToolAllowlist: ["update_plan"],
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });

    expect(tools).toContain("progress_card");
  });

  it("includes progress_card when a config allowlist group includes it", () => {
    const includeProgressCard = shouldIncludeProgressCardToolForAforaTools({
      config: { tools: { allow: ["group:agents"] } } as AforaConfig,
    });

    expect(includeProgressCard).toBe(true);
  });

  it("leaves normal deny policy enforcement to the assembled tool set", () => {
    const tools = createFastToolNames({
      config: {} as AforaConfig,
      pluginToolAllowlist: ["group:agents"],
      pluginToolDenylist: ["update_plan"],
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });

    expect(tools).not.toContain("progress_card");
  });

  it("lets an explicit updatePlan false override an allowlist that includes the tool", () => {
    expectProgressCardEnabled(
      { config: { tools: { updatePlan: false, allow: ["update_plan"] } } as AforaConfig },
      false,
    );
  });
});

function findAforaTool(name: string, modelHasVision?: boolean) {
  return createTestAforaTools({ modelHasVision }).find((tool) => tool.name === name);
}

describe("model capability registration", () => {
  it("omits computer input for models that cannot see the reference frame", () => {
    expect(findAforaTool("computer", false)).toBeUndefined();
  });

  it("keeps computer when vision is supported or not yet resolved", () => {
    expect(findAforaTool("computer", true)).toBeDefined();
    expect(findAforaTool("computer")).toBeDefined();
  });

  it("keeps computer screenshots on the direct model-visible tool surface", () => {
    expect(findAforaTool("computer", true)?.catalogMode).toBe("direct-only");
  });

  it("registers mobile UI independent of model vision", () => {
    expect(findAforaTool("mobile_ui", false)).toBeDefined();
    expect(findAforaTool("mobile_ui", true)).toBeDefined();
    expect(findAforaTool("mobile_ui")).toBeDefined();
  });

  it("keeps mobile UI one-action-at-a-time execution explicit", () => {
    expect(findAforaTool("mobile_ui")?.executionMode).toBe("sequential");
  });
});

function stubAgentTool(name: string): AnyAgentTool {
  return {
    label: name,
    name,
    description: `${name} stub`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return textResult("ok", {});
    },
  };
}

describe.each([
  { suite: "image", toolName: "image_generate", article: "an", label: "image-generation tool" },
  { suite: "video", toolName: "video_generate", article: "a", label: "video-generation tool" },
])("afora tools $suite generation registration", ({ toolName, article, label }) => {
  it(`registers ${toolName} when ${article} ${label} is present`, () => {
    const tool = stubAgentTool(toolName);
    expect(collectPresentAforaTools([tool])).toEqual([tool]);
  });

  it(`omits ${toolName} when ${article} ${label} is absent`, () => {
    expect(collectPresentAforaTools([null]).map((tool) => tool.name)).not.toContain(toolName);
  });
});

describe("PDF registration", () => {
  it("includes the pdf tool when the pdf factory returns a tool", () => {
    const pdfTool = createPdfTool({
      agentDir: "/tmp/afora-agent-main",
      config: {
        agents: { defaults: { pdfModel: { primary: "openai/gpt-5.4-mini" } } },
      },
    });

    expect(pdfTool?.name).toBe("pdf");
    expect(collectPresentAforaTools([pdfTool]).map((tool) => tool.name)).toEqual(["pdf"]);
  });
});

function createSwarmToolNames(options: NonNullable<Parameters<typeof createAforaTools>[0]>) {
  const config = options.config ?? {};
  return createAforaTools({
    disableMessageTool: true,
    disablePluginTools: true,
    wrapBeforeToolCallHook: false,
    ...options,
    config: {
      ...config,
      agents: config.agents ?? { entries: { main: {} } },
    },
  }).map((tool) => tool.name);
}

describe("Swarm registration", () => {
  it("registers agents_wait only when tools.swarm is enabled", () => {
    const base = { agentSessionKey: "agent:main:main" };
    expect(createSwarmToolNames(base)).not.toContain("agents_wait");
    expect(createSwarmToolNames({ ...base, config: { tools: { swarm: true } } })).toContain(
      "agents_wait",
    );
  });

  it("uses the effective requester agent override for the agents_wait gate", () => {
    const base = {
      agentSessionKey: "agent:worker:main",
      requesterAgentIdOverride: "worker",
    };
    expect(
      createSwarmToolNames({
        ...base,
        config: {
          tools: { swarm: false },
          agents: {
            list: [{ id: "main" }, { id: "worker", tools: { swarm: true } }],
          },
        },
      }),
    ).toContain("agents_wait");
    expect(
      createSwarmToolNames({
        ...base,
        config: {
          tools: { swarm: true },
          agents: {
            list: [{ id: "main" }, { id: "worker", tools: { swarm: false } }],
          },
        },
      }),
    ).not.toContain("agents_wait");
  });

  it("advertises sessions_spawn from agents_wait only when spawn is available", () => {
    setEmbeddedMode(true);
    try {
      const createTools = (allowGatewaySubagentBinding: boolean) =>
        createTestAforaTools({
          agentSessionKey: "agent:main:main",
          allowGatewaySubagentBinding,
          config: { tools: { swarm: true } } as AforaConfig,
          disableMessageTool: true,
          disablePluginTools: true,
          wrapBeforeToolCallHook: false,
        });
      const withoutSpawn = applyToolAvailabilityDescriptions(createTools(false));
      const withSpawn = applyToolAvailabilityDescriptions(createTools(true));

      expect(toolNames(withoutSpawn)).not.toContain("sessions_spawn");
      expect(expectToolNamed(withoutSpawn, "agents_wait").description).not.toContain(
        "sessions_spawn",
      );
      expect(toolNames(withSpawn)).toContain("sessions_spawn");
      expect(expectToolNamed(withSpawn, "agents_wait").description).toContain("sessions_spawn");
    } finally {
      setEmbeddedMode(false);
    }
  });

  it("injects structured_output only for schema-backed collector runs", () => {
    const base = {
      agentSessionKey: "agent:worker:subagent:child",
      runId: "collector-run",
      config: { tools: { swarm: true } },
    };
    expect(createSwarmToolNames({ ...base, swarmCollector: true })).not.toContain(
      "structured_output",
    );
    expect(
      createSwarmToolNames({
        ...base,
        swarmCollector: true,
        swarmOutputSchema: { type: "object", properties: { answer: { type: "string" } } },
      }),
    ).toContain("structured_output");
  });

  it("keeps structured_output through restrictive child tool policy", () => {
    const names = createAforaCodingTools({
      sessionKey: "agent:worker:subagent:child",
      runId: "collector-run",
      config: {
        agents: { entries: { main: { default: true } } },
        tools: { allow: ["read"], swarm: true },
      },
      swarmCollector: true,
      swarmOutputSchema: { type: "object", properties: { answer: { type: "string" } } },
    }).map((tool) => tool.name);

    expect(names).toContain("read");
    expect(names).toContain("structured_output");
    expect(names).not.toContain("exec");
  });

  it("omits the message tool for collector runs by invariant", () => {
    const names = createAforaCodingTools({
      sessionKey: "agent:worker:subagent:child",
      runId: "collector-run",
      config: {
        agents: { entries: { main: { default: true } } },
        tools: { swarm: true },
      },
      swarmCollector: true,
    }).map((tool) => tool.name);

    expect(names).not.toContain("message");
  });

  it("omits interactive and pausing tools for non-interactive collector runs", () => {
    const names = createAforaCodingTools({
      sessionKey: "agent:worker:main",
      runId: "collector-run",
      config: {
        agents: { entries: { main: { default: true } } },
        tools: { swarm: true },
      },
      swarmCollector: true,
    }).map((tool) => tool.name);

    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("sessions_send");
    expect(names).not.toContain("sessions_yield");
  });
});

describe("sessions_yield completion ownership", () => {
  const controllerSessionKey = "agent:main:telegram:default:direct:1234";

  it.each([
    ["the durable run owner", "agent:main:main", "agent:main:main"],
    ["a trimmed durable run owner", "  agent:main:main  ", "agent:main:main"],
    ["the controller when the run owner is blank", "   ", controllerSessionKey],
    ["the controller when the run owner is absent", undefined, controllerSessionKey],
  ] as const)("records yield intent against %s", async (_, runSessionKey, expectedSessionKey) => {
    const registry = await import("./subagents/registry/subagent-registry.js");
    const markRequesterTurnYielded = vi
      .spyOn(registry, "markRequesterTurnYielded")
      .mockReturnValue(1);
    const onYield = vi.fn(async () => undefined);

    try {
      const tool = expectToolNamed(
        createTestAforaTools({
          agentSessionKey: controllerSessionKey,
          runSessionKey,
          sessionId: "requester-session",
          runId: "run-requester",
          onYield,
          disableMessageTool: true,
          disablePluginTools: true,
          wrapBeforeToolCallHook: false,
        }),
        "sessions_yield",
      );

      const result = await tool.execute("yield-requester", {});

      expect(result.details).toMatchObject({ status: "yielded" });
      expect(markRequesterTurnYielded).toHaveBeenCalledExactlyOnceWith({
        requesterAgentId: "main",
        requesterSessionKey: expectedSessionKey,
        requesterTurnRunId: "run-requester",
      });
      expect(onYield).toHaveBeenCalledOnce();
      expect(markRequesterTurnYielded.mock.invocationCallOrder[0]).toBeLessThan(
        onYield.mock.invocationCallOrder[0]!,
      );
    } finally {
      markRequesterTurnYielded.mockRestore();
    }
  });
});

function hasTool(tools: readonly { name: string }[], name: string): boolean {
  return tools.some((tool) => tool.name === name);
}

describe("gateway client capability tool filtering", () => {
  it.each([
    { name: "no gateway client caps exist", clientCaps: undefined },
    { name: "a required cap is absent", clientCaps: ["tool-events"] },
  ])("excludes capability-gated tools when $name", ({ clientCaps }) => {
    expect(hasTool(createAforaTools({ clientCaps }), "show_widget")).toBe(false);
  });

  it("includes capability-gated tools when the client caps are a superset", () => {
    expect(
      hasTool(
        createAforaTools({ clientCaps: ["tool-events", "inline-widgets"] }),
        "show_widget",
      ),
    ).toBe(true);
  });

  it("keeps the core widget tool out of Discord sessions", () => {
    expect(
      hasTool(
        createAforaTools({ agentChannel: "discord", clientCaps: ["inline-widgets"] }),
        "show_widget",
      ),
    ).toBe(false);
  });

  it("keeps the core widget tool out when Canvas host config disables it", () => {
    expect(
      hasTool(
        createAforaTools({
          clientCaps: ["inline-widgets"],
          config: {
            plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
          },
        }),
        "show_widget",
      ),
    ).toBe(false);
  });

  it("keeps the core widget tool out when AFORA_SKIP_CANVAS_HOST is set", () => {
    withEnv({ AFORA_SKIP_CANVAS_HOST: "1" }, () => {
      expect(hasTool(createAforaTools({ clientCaps: ["inline-widgets"] }), "show_widget")).toBe(
        false,
      );
    });
  });

  it("only exposes screen to UI-command clients", () => {
    expect(hasTool(createAforaTools(), "screen")).toBe(false);
    expect(hasTool(createAforaTools({ clientCaps: ["ui-commands"] }), "screen")).toBe(true);
  });

  it("omits host UI runtime tools for sandboxed agents", () => {
    expect(hasTool(createAforaTools({ agentSessionKey: "agent:main:main" }), "terminal")).toBe(
      true,
    );
    expect(hasTool(createAforaTools({ agentSessionKey: "agent:main:main" }), "portal")).toBe(
      true,
    );
    expect(
      hasTool(
        createAforaTools({ agentSessionKey: "agent:main:main", sandboxed: true }),
        "terminal",
      ),
    ).toBe(false);
    expect(
      hasTool(
        createAforaTools({ agentSessionKey: "agent:main:main", sandboxed: true }),
        "portal",
      ),
    ).toBe(false);
  });

  it("does not let tools.allow resurrect a gated tool for a channel run", () => {
    const tools = createAforaCodingTools({
      messageProvider: "telegram",
      disableMessageTool: true,
      config: { tools: { allow: ["show_widget"] } },
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeAforaTools: true,
        includePluginTools: true,
      },
    });

    expect(hasTool(tools, "show_widget")).toBe(false);
  });

  it("does not add the core widget tool to plugin-only construction plans", () => {
    const plan = {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeAforaTools: false,
      includePluginTools: true,
    };

    expect(
      hasTool(
        createAforaCodingTools({ messageProvider: "telegram", toolConstructionPlan: plan }),
        "show_widget",
      ),
    ).toBe(false);
    expect(
      hasTool(
        createAforaCodingTools({
          messageProvider: "webchat",
          clientCaps: ["inline-widgets"],
          toolConstructionPlan: plan,
        }),
        "show_widget",
      ),
    ).toBe(false);
    expect(
      hasTool(
        createAforaCodingTools({ messageProvider: "webchat", toolConstructionPlan: plan }),
        "progress_card",
      ),
    ).toBe(false);
  });
});
