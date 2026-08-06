/** Tests configured model aliases through parser and reply-routing boundaries. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { FinalizedTemplateContext as TemplateContext } from "../templating.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import {
  reserveSkillCommandNames,
  resolveConfiguredDirectiveAliases,
} from "./get-reply-directive-aliases.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { withFastReplyConfig } from "./get-reply-fast-path.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

const directiveApplyMocks = vi.hoisted(() => ({
  apply: vi.fn(),
}));

vi.mock("./get-reply-directives-apply.js", () => ({
  applyInlineDirectiveOverrides: (...args: unknown[]) => directiveApplyMocks.apply(...args),
}));

type DirectiveApplyParams = Parameters<
  typeof import("./get-reply-directives-apply.js").applyInlineDirectiveOverrides
>[0];

function configWithModelAlias(alias: string): OpenClawConfig {
  return {
    commands: { text: true },
    agents: {
      defaults: {
        models: {
          "anthropic/claude-opus-4-6": { alias },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

function createAliasIndex(): ModelAliasIndex {
  return {
    byAlias: new Map([
      [
        "fable",
        {
          alias: "fable",
          ref: { provider: "anthropic", model: "claude-opus-4-6" },
        },
      ],
    ]),
    byKey: new Map([["anthropic/claude-opus-4-6", ["fable"]]]),
  };
}

function createSessionEntry(): SessionEntry {
  return { sessionId: "session-1", updatedAt: 1 };
}

function makeTypingController() {
  return {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };
}

async function resolveAliasDirective(body: string) {
  const sessionKey = "agent:main:whatsapp:+2000";
  const sessionEntry = createSessionEntry();
  const sessionCtx = {
    Body: body,
    BodyStripped: body,
    BodyForAgent: body,
    CommandBody: body,
    commandText: body,
    agentText: body,
    rawText: body,
    Provider: "whatsapp",
    Surface: "whatsapp",
  } as TemplateContext;
  const result = await resolveReplyDirectives({
    ctx: buildTestCtx({
      Body: body,
      CommandBody: body,
      CommandAuthorized: true,
    }),
    cfg: withFastReplyConfig(configWithModelAlias("fable")),
    agentId: "main",
    agentDir: "/tmp/main-agent",
    workspaceDir: "/tmp",
    agentCfg: {},
    sessionCtx,
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    sessionScope: "per-sender",
    groupResolution: undefined,
    isGroup: false,
    triggerBodyNormalized: body,
    resetTriggered: false,
    commandAuthorized: true,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: createAliasIndex(),
    provider: "anthropic",
    model: "claude-opus-4-6",
    hasResolvedHeartbeatModelOverride: false,
    typing: makeTypingController(),
  });
  return { result, sessionEntry, sessionCtx };
}

describe("reply directive aliases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    directiveApplyMocks.apply.mockImplementation(async (params: DirectiveApplyParams) => ({
      kind: "continue",
      directives: params.directives,
      provider: params.provider,
      model: params.model,
      contextTokens: params.contextTokens,
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      body: "/fable -s",
      expected: {
        cleaned: "",
        hasModelDirective: true,
        rawModelDirective: "fable",
        modelSessionOnly: true,
      },
    },
    {
      body: "please /fable -s",
      expected: {
        cleaned: "please",
        hasModelDirective: false,
        rawModelDirective: undefined,
        modelSessionOnly: false,
      },
    },
  ])("routes configured alias scope at the reply boundary: $body", async ({ body, expected }) => {
    const { result, sessionEntry, sessionCtx } = await resolveAliasDirective(body);

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error(`expected continue result, got ${result.kind}`);
    }
    expect(result.result.directives).toMatchObject(expected);
    expect(result.result.cleanedBody).toBe(expected.cleaned);
    expect(sessionCtx.Body).toBe(expected.cleaned);
    expect(sessionEntry).toEqual(createSessionEntry());
  });

  it("parses configured alias session scope through the inline directive boundary", () => {
    const cfg = configWithModelAlias("fable");
    const parsed = parseInlineDirectives("/fable -s", {
      modelAliases: resolveConfiguredDirectiveAliases({
        cfg,
        commandTextHasSlash: true,
        reservedCommands: new Set(),
      }),
    });

    expect(parsed).toMatchObject({
      cleaned: "",
      hasModelDirective: true,
      rawModelDirective: "fable",
      rawModelRuntime: undefined,
      modelSessionOnly: true,
    });
  });

  it("does not expose skill command names as inline model aliases", () => {
    const reservedCommands = new Set<string>();
    const cfg = configWithModelAlias("demo_skill");

    const beforeSkillRegistration = parseInlineDirectives("/demo_skill", {
      modelAliases: resolveConfiguredDirectiveAliases({
        cfg,
        commandTextHasSlash: true,
        reservedCommands,
      }),
    });
    expect(beforeSkillRegistration.hasModelDirective).toBe(true);
    expect(beforeSkillRegistration.cleaned).toBe("");

    reserveSkillCommandNames({
      reservedCommands,
      skillCommands: [
        {
          name: "demo_skill",
          skillName: "demo-skill",
          description: "Demo skill",
          sourceFilePath: "/tmp/demo/SKILL.md",
        },
      ],
    });

    const afterSkillRegistration = parseInlineDirectives("/demo_skill", {
      modelAliases: resolveConfiguredDirectiveAliases({
        cfg,
        commandTextHasSlash: true,
        reservedCommands,
      }),
    });
    expect(afterSkillRegistration.hasModelDirective).toBe(false);
    expect(afterSkillRegistration.cleaned).toBe("/demo_skill");
  });

  it("does not expose chat command names as inline model aliases", () => {
    const cfg = configWithModelAlias(" help ");
    const reservedCommands = new Set(["help"]);

    const parsed = parseInlineDirectives("/help", {
      modelAliases: resolveConfiguredDirectiveAliases({
        cfg,
        commandTextHasSlash: true,
        reservedCommands,
      }),
    });
    expect(parsed.hasModelDirective).toBe(false);
    expect(parsed.cleaned).toBe("/help");
  });
});
