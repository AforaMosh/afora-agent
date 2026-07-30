import { runMemoryAuthorizationConformanceSuite } from "openclaw/plugin-sdk/memory-authorization";
// Memory Core provider tests cover plugin runtime integration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { describe, expect, it, vi } from "vitest";
import { MEMORY_CORE_AUTHORIZATION_CAPABILITIES } from "./authorization.js";

const managerDebug = {
  backend: "qmd" as const,
  purpose: "default" as const,
  managerMs: 7,
  managerCacheState: "cached-full-hit" as const,
  qmdIdentityHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const getMemorySearchManagerMock = vi.hoisted(() =>
  vi.fn(async () => ({
    manager: null,
    debug: managerDebug,
    error: undefined,
  })),
);

vi.mock("./memory/index.js", () => ({
  closeAllMemorySearchManagers: vi.fn(async () => {}),
  closeMemorySearchManager: vi.fn(async () => {}),
  getMemorySearchManager: getMemorySearchManagerMock,
}));

import { createMemoryRuntime, memoryRuntime } from "./runtime-provider.js";

describe("memoryRuntime", () => {
  it("declares the admitted Phase 2A mutation capabilities", () => {
    expect(memoryRuntime.authorization).toEqual(MEMORY_CORE_AUTHORIZATION_CAPABILITIES);
    expect(memoryRuntime.authorize).toEqual(expect.any(Function));
    expect(memoryRuntime.searchAuthorized).toEqual(expect.any(Function));
    expect(memoryRuntime.readAuthorized).toEqual(expect.any(Function));
    expect(memoryRuntime.writeAuthorized).toEqual(expect.any(Function));
    expect(memoryRuntime.importAuthorized).toEqual(expect.any(Function));
    expect(memoryRuntime.syncAuthorized).toEqual(expect.any(Function));
    expect(memoryRuntime.exportAuthorized).toEqual(expect.any(Function));
    expect(memoryRuntime.statusAuthorized).toEqual(expect.any(Function));
  });

  it("passes the full host-run authorization conformance suite", async () => {
    expect(memoryRuntime.authorizationConformance).toBeDefined();
    await expect(
      runMemoryAuthorizationConformanceSuite(memoryRuntime.authorizationConformance!),
    ).resolves.toEqual({ ok: true, failures: [] });
  });

  it("preserves manager debug metadata", async () => {
    const cfg = {} as OpenClawConfig;

    const result = await memoryRuntime.getMemorySearchManager({
      cfg,
      agentId: "main",
    });

    expect(result.debug).toEqual(managerDebug);
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
    });
  });

  it("keeps local-service acquisition scoped to each runtime instance", async () => {
    const cfg = {} as OpenClawConfig;
    const firstAcquire = vi.fn(async () => undefined);
    const secondAcquire = vi.fn(async () => undefined);

    await Promise.all([
      createMemoryRuntime({ acquireLocalService: firstAcquire }).getMemorySearchManager({
        cfg,
        agentId: "first",
      }),
      createMemoryRuntime({ acquireLocalService: secondAcquire }).getMemorySearchManager({
        cfg,
        agentId: "second",
      }),
    ]);

    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg,
      agentId: "first",
      acquireLocalService: firstAcquire,
    });
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg,
      agentId: "second",
      acquireLocalService: secondAcquire,
    });
  });

  it("keeps SQLite lease coordination scoped to each runtime instance", async () => {
    const cfg = {} as OpenClawConfig;
    const firstLease = vi.fn();
    const secondLease = vi.fn();

    await Promise.all([
      createMemoryRuntime({ withLease: firstLease }).getMemorySearchManager({
        cfg,
        agentId: "first",
      }),
      createMemoryRuntime({ withLease: secondLease }).getMemorySearchManager({
        cfg,
        agentId: "second",
      }),
    ]);

    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg,
      agentId: "first",
      withLease: firstLease,
    });
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg,
      agentId: "second",
      withLease: secondLease,
    });
  });
});
