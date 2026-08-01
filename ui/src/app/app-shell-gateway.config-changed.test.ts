// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ShellGatewayOwner, type ShellGatewayHost } from "./app-shell-gateway.ts";
import type { ApplicationContext } from "./context.ts";

describe("ShellGatewayOwner config.changed", () => {
  it("records freshness while a local draft is dirty", () => {
    const refreshAfterCurrentLoad = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);
    const context = {
      runtimeConfig: {
        state: { configFormDirty: true },
        refreshAfterCurrentLoad,
        refresh,
      },
    } as unknown as ApplicationContext;
    const owner = new ShellGatewayOwner({
      context,
      sidebarWorkboardRuntime: null,
      agentRosterRefreshTimer: null,
      requestUpdate: vi.fn(),
    } as unknown as ShellGatewayHost);

    owner.handleGatewayEvent({ type: "event", event: "config.changed", payload: {} });

    expect(refreshAfterCurrentLoad).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  });
});
