import {
  callGatewayTool,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codexTestTurnIds } from "./codex-app-server.test-fixtures.js";
import { handleCodexAppServerElicitationRequest } from "./elicitation-bridge.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

function createDiscordParams(): EmbeddedRunAttemptParams {
  return {
    sessionKey: "agent:main:discord:channel:123456789",
    agentId: "main",
    messageChannel: "discord",
    currentChannelId: "channel:123456789",
    agentAccountId: "default",
    currentThreadTs: "777888999",
  } as unknown as EmbeddedRunAttemptParams;
}

function buildToolSuggestion(overrides: Record<string, unknown> = {}) {
  return {
    ...codexTestTurnIds(),
    serverName: "codex_apps",
    mode: "form",
    message: "Google Calendar can create the requested event.",
    _meta: {
      codex_approval_kind: "tool_suggestion",
      persist: "always",
      tool_type: "plugin",
      suggest_type: "install",
      suggest_reason: "Google Calendar can create the requested event.",
      tool_id: "google-calendar@openai-curated-remote",
      tool_name: "Google Calendar",
    },
    requestedSchema: {
      type: "object",
      properties: {},
    },
    ...overrides,
  };
}

describe("Codex app-server tool-suggestion elicitations", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
  });

  it("routes a remote plugin install prompt to the originating Discord session before installing", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:install-1", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:install-1", decision: "allow-once" });
    const appServerRequest = vi.fn(async (method: string) => {
      if (method === "plugin/list") {
        return {
          marketplaces: [
            {
              name: "openai-curated-remote",
              path: null,
              plugins: [
                {
                  id: "google-calendar@openai-curated-remote",
                  remotePluginId: "plugin_connector_google_calendar",
                  name: "Google Calendar",
                  installed: false,
                  enabled: false,
                },
              ],
            },
          ],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        };
      }
      if (method === "plugin/install") {
        return { authPolicy: "none", appsNeedingAuth: [] };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildToolSuggestion(),
      paramsForRun: createDiscordParams(),
      appServerRequest,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ action: "accept", content: null, _meta: null });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(mockCallGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      toolName: "codex_plugin_install",
      turnSourceChannel: "discord",
      turnSourceTo: "channel:123456789",
      turnSourceAccountId: "default",
      turnSourceThreadId: "777888999",
    });
    expect(appServerRequest).toHaveBeenNthCalledWith(1, "plugin/list", {});
    expect(appServerRequest).toHaveBeenNthCalledWith(2, "plugin/install", {
      remoteMarketplaceName: "openai-curated-remote",
      pluginName: "plugin_connector_google_calendar",
    });
  });

  it("relays a connector install URL and waits for explicit channel confirmation", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "connector:install-1", status: "accepted" })
      .mockResolvedValueOnce({ id: "connector:install-1", decision: "allow-once" });
    const installUrl =
      "https://chatgpt.com/apps/google-calendar/connector_2128aebfecb84f64a069897515042a44";

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildToolSuggestion({
        _meta: {
          codex_approval_kind: "tool_suggestion",
          persist: "always",
          tool_type: "connector",
          suggest_type: "install",
          suggest_reason: "Google Calendar can create the requested event.",
          tool_id: "connector_2128aebfecb84f64a069897515042a44",
          tool_name: "Google Calendar",
          install_url: installUrl,
        },
      }),
      paramsForRun: createDiscordParams(),
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ action: "accept", content: null, _meta: null });
    expect(mockCallGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      toolName: "codex_connector_install",
      turnSourceChannel: "discord",
      turnSourceTo: "channel:123456789",
    });
    expect(mockCallGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      description: expect.stringContaining(installUrl),
    });
  });

  it("does not prompt or install for another active turn", async () => {
    const appServerRequest = vi.fn();

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildToolSuggestion({ turnId: "turn-other" }),
      paramsForRun: createDiscordParams(),
      appServerRequest,
      ...codexTestTurnIds(),
    });

    expect(result).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(appServerRequest).not.toHaveBeenCalled();
  });

  it("does not install a plugin when the channel approval is denied", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:install-denied", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:install-denied", decision: "deny" });
    const appServerRequest = vi.fn();

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildToolSuggestion(),
      paramsForRun: createDiscordParams(),
      appServerRequest,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(appServerRequest).not.toHaveBeenCalled();
  });

  it("does not install when the gateway returns a decision the prompt did not advertise", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:install-unadvertised", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:install-unadvertised",
        decision: "allow-always",
      });
    const appServerRequest = vi.fn();

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildToolSuggestion(),
      paramsForRun: createDiscordParams(),
      appServerRequest,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(appServerRequest).not.toHaveBeenCalled();
  });

  it("relays plugin app authorization and verifies accessibility before accepting", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:install-auth", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:install-auth", decision: "allow-once" })
      .mockResolvedValueOnce({ id: "plugin:authorize-app", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:authorize-app", decision: "allow-once" });
    const authorizationUrl = "https://chatgpt.com/apps/google-calendar/authorize";
    const appServerRequest = vi.fn(async (method: string) => {
      if (method === "plugin/list") {
        return {
          marketplaces: [
            {
              name: "openai-curated-remote",
              path: null,
              plugins: [
                {
                  id: "google-calendar@openai-curated-remote",
                  remotePluginId: "plugin_connector_google_calendar",
                  name: "Google Calendar",
                  installed: false,
                  enabled: false,
                },
              ],
            },
          ],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        };
      }
      if (method === "plugin/install") {
        return {
          authPolicy: "ON_INSTALL",
          appsNeedingAuth: [
            {
              id: "connector_google_calendar",
              name: "Google Calendar",
              description: null,
              installUrl: authorizationUrl,
              category: null,
            },
          ],
        };
      }
      if (method === "app/list") {
        return {
          data: [{ id: "connector_google_calendar", isAccessible: true }],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildToolSuggestion(),
      paramsForRun: createDiscordParams(),
      appServerRequest,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ action: "accept", content: null, _meta: null });
    expect(mockCallGatewayTool.mock.calls[2]?.[2]).toMatchObject({
      toolName: "codex_app_authorization",
      description: expect.stringContaining(authorizationUrl),
      turnSourceChannel: "discord",
      turnSourceTo: "channel:123456789",
    });
    expect(appServerRequest).toHaveBeenLastCalledWith("app/list", {
      threadId: codexTestTurnIds().threadId,
      forceRefetch: true,
    });
  });

  it("surfaces but cannot accept a connector suggestion with an unsafe install URL", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "connector:unsafe", status: "accepted" })
      .mockResolvedValueOnce({ id: "connector:unsafe", decision: "allow-once" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildToolSuggestion({
        _meta: {
          codex_approval_kind: "tool_suggestion",
          persist: "always",
          tool_type: "connector",
          suggest_type: "install",
          suggest_reason: "Google Calendar can create the requested event.",
          tool_id: "connector_unsafe",
          tool_name: "Google Calendar",
          install_url: "javascript:alert(1)",
        },
      }),
      paramsForRun: createDiscordParams(),
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(mockCallGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      description: expect.stringContaining("did not provide a safe install link"),
      allowedDecisions: ["deny"],
    });
  });

  it("uses the originating messaging target when a direct channel has no channel id", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "connector:direct", status: "accepted" })
      .mockResolvedValueOnce({ id: "connector:direct", decision: "allow-once" });
    const paramsForRun = createDiscordParams();
    paramsForRun.messageChannel = "whatsapp";
    paramsForRun.currentChannelId = undefined;
    paramsForRun.currentMessagingTarget = "+15555550123";

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildToolSuggestion({
        _meta: {
          codex_approval_kind: "tool_suggestion",
          persist: "always",
          tool_type: "connector",
          suggest_type: "install",
          suggest_reason: "Google Calendar can create the requested event.",
          tool_id: "connector_direct",
          tool_name: "Google Calendar",
          install_url: "https://chatgpt.com/apps/google-calendar/connector_direct",
        },
      }),
      paramsForRun,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ action: "accept", content: null, _meta: null });
    expect(mockCallGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      turnSourceChannel: "whatsapp",
      turnSourceTo: "+15555550123",
    });
  });
});
