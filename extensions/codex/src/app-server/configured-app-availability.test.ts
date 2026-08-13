import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexConfiguredAppAvailabilityMonitor } from "./configured-app-availability.js";

describe("configured Codex app availability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns once when an explicitly enabled app is not installed or authorized", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const request = vi.fn(async (method: string) =>
      method === "config/read"
        ? {
            config: {
              apps: {
                _default: { enabled: false },
                slack: { enabled: true },
                linear: { enabled: false },
              },
            },
          }
        : { apps: [{ id: "github", enabled: true, callable: true }] },
    );
    const monitor = new CodexConfiguredAppAvailabilityMonitor();
    const params = {
      client: { request } as never,
      appCacheKey: "account-a",
      configCwd: "/workspace",
      timeoutMs: 1_000,
    };

    await monitor.check(params);
    await monitor.check(params);

    expect(request.mock.calls.map(([method]) => method)).toEqual(["config/read", "app/installed"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "configured Codex app is unavailable; install or authorize it to expose its tools",
      { appId: "slack", state: "not_installed_or_authorized" },
    );
  });

  it("does not warn when every explicitly enabled app is installed", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const request = vi.fn(async (method: string) =>
      method === "config/read"
        ? { config: { apps: { slack: { enabled: true } } } }
        : { apps: [{ id: "slack", enabled: true, callable: true }] },
    );

    await new CodexConfiguredAppAvailabilityMonitor().check({
      client: { request } as never,
      appCacheKey: "account-a",
      timeoutMs: 1_000,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("skips app inventory when no app is explicitly enabled", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const request = vi.fn(async () => ({
      config: { apps: { _default: { enabled: false }, slack: { enabled: false } } },
    }));

    await new CodexConfiguredAppAvailabilityMonitor().check({
      client: { request } as never,
      appCacheKey: "account-a",
      timeoutMs: 1_000,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
