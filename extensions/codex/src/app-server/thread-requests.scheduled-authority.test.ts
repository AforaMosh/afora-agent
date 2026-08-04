import { describe, expect, it } from "vitest";
import {
  buildCodexScheduledRuntimeAuthorityConfigPatch,
  readCodexInheritedMcpServerState,
} from "./thread-requests.js";

describe("buildCodexScheduledRuntimeAuthorityConfigPatch", () => {
  it("enables only captured apps and exact user MCP tools while disabling broader native context", () => {
    expect(
      buildCodexScheduledRuntimeAuthorityConfigPatch({
        authority: {
          version: 1,
          runtime: "codex",
          openClawTools: ["cron"],
          apps: [
            {
              appId: "todoist",
              allowDestructiveActions: false,
              allowOpenWorld: true,
              approvalMode: "ask",
            },
          ],
          userMcpServers: [{ serverName: "todoist", toolNames: ["add", "list"] }],
          pluginMcpServers: [
            { pluginId: "calendar", serverName: "calendar-native", toolNames: ["events"] },
          ],
        },
        inheritedMcpServerNames: ["todoist", "new-after-creation"],
        inheritedApps: {
          todoist: {
            tools: {
              delete_task: { approval_mode: "approve" },
              read_task: { approval_mode: "writes" },
              revoked_task: { enabled: false, approval_mode: "auto" },
            },
          },
        },
      }),
    ).toEqual({
      "features.apps": true,
      "features.plugins": false,
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
        todoist: {
          enabled: true,
          destructive_enabled: false,
          open_world_enabled: true,
          default_tools_approval_mode: "prompt",
          approvals_reviewer: "user",
          tools: {
            delete_task: { approval_mode: "prompt" },
            read_task: { approval_mode: "prompt" },
            revoked_task: { enabled: false, approval_mode: "prompt" },
          },
        },
      },
      mcp_servers: {
        todoist: { enabled: true, enabled_tools: ["add", "list"] },
        "new-after-creation": { enabled: false },
        "calendar-native": { enabled: false },
      },
    });
  });
});

describe("readCodexInheritedMcpServerState", () => {
  it("retains current per-server tool allow and deny policy for authority intersection", async () => {
    const request = async () => ({
      layers: [],
      config: {
        mcp_servers: {
          todoist: {
            enabled: true,
            enabled_tools: ["add", "list"],
            disabled_tools: ["add"],
          },
          revoked: { enabled: false },
        },
      },
    });

    await expect(
      readCodexInheritedMcpServerState({ request } as never, "/workspace"),
    ).resolves.toMatchObject({
      all: ["revoked", "todoist"],
      enabled: ["todoist"],
      toolPolicies: {
        todoist: { enabled: ["add", "list"], disabled: ["add"] },
      },
    });
  });
});
