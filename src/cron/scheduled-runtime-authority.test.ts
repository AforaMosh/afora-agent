import { describe, expect, it } from "vitest";
import {
  bindScheduledRuntimeAuthorityToToolsAllow,
  normalizeScheduledRuntimeAuthority,
  type ScheduledRuntimeAuthority,
} from "./scheduled-runtime-authority.js";

function authority(): ScheduledRuntimeAuthority {
  return {
    version: 1,
    runtime: "codex",
    openClawTools: ["cron", "read"],
    apps: [
      {
        appId: "todoist",
        allowDestructiveActions: false,
        allowOpenWorld: true,
        approvalMode: "ask",
      },
    ],
    userMcpServers: [{ serverName: "todoist-mcp", toolNames: ["tasks/add", "tasks/list"] }],
    pluginMcpServers: [
      { pluginId: "calendar", serverName: "calendar-mcp", toolNames: ["events/list"] },
    ],
  };
}

describe("scheduled runtime authority", () => {
  it("normalizes deterministically and distinguishes an explicit empty grant", () => {
    const value = authority();
    value.openClawTools.reverse();
    value.userMcpServers[0]!.toolNames.reverse();
    expect(normalizeScheduledRuntimeAuthority(value)).toEqual(authority());
    expect(
      normalizeScheduledRuntimeAuthority({
        version: 1,
        runtime: "codex",
        openClawTools: [],
        apps: [],
        userMcpServers: [],
        pluginMcpServers: [],
      }),
    ).toBeDefined();
    expect(normalizeScheduledRuntimeAuthority(undefined)).toBeUndefined();
  });

  it("rejects unknown fields, versions, duplicates, and aggregate oversized grants", () => {
    expect(normalizeScheduledRuntimeAuthority({ ...authority(), version: 2 })).toBeUndefined();
    expect(normalizeScheduledRuntimeAuthority({ ...authority(), secret: "nope" })).toBeUndefined();
    expect(
      normalizeScheduledRuntimeAuthority({
        ...authority(),
        apps: [...authority().apps, ...authority().apps],
      }),
    ).toBeUndefined();
    expect(
      normalizeScheduledRuntimeAuthority({
        ...authority(),
        userMcpServers: Array.from({ length: 257 }, (_, index) => ({
          serverName: `server-${index}`,
          toolNames: [],
        })),
      }),
    ).toBeUndefined();
  });

  it("binds duplicated OpenClaw names to the canonical payload cap", () => {
    expect(
      bindScheduledRuntimeAuthorityToToolsAllow({
        authority: authority(),
        toolsAllow: ["cron"],
      }).openClawTools,
    ).toEqual(["cron"]);
  });
});
