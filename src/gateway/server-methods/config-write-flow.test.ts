import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const configMocks = vi.hoisted(() => ({
  replaceConfigFileWithIntent: vi.fn(),
  resolveConfigSnapshotHash: vi.fn(),
}));
const secretsMocks = vi.hoisted(() => ({
  activeSnapshot: null as {
    sourceConfig: OpenClawConfig;
    config: OpenClawConfig;
  } | null,
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    replaceConfigFileWithIntent: configMocks.replaceConfigFileWithIntent,
    resolveConfigSnapshotHash: configMocks.resolveConfigSnapshotHash,
  };
});

vi.mock("../../secrets/runtime-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../secrets/runtime-state.js")>();
  return {
    ...actual,
    getActiveSecretsRuntimeSnapshot: () => secretsMocks.activeSnapshot,
  };
});

import { commitGatewayConfigWrite, didActiveSharedGatewayAuthChange } from "./config-write-flow.js";

describe("commitGatewayConfigWrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.resolveConfigSnapshotHash.mockReturnValue("missing-config-revision");
    secretsMocks.activeSnapshot = null;
    configMocks.replaceConfigFileWithIntent.mockResolvedValue({
      nextConfig: {},
      persistedHash: "persisted-hash",
    });
  });

  it("carries a missing file revision into the lock-time compare-and-swap", async () => {
    const snapshot = {
      path: "/tmp/openclaw.json",
      exists: false,
      raw: null,
      hash: "missing-config-revision",
    };

    await commitGatewayConfigWrite({
      snapshot: snapshot as never,
      writeOptions: {},
      nextConfig: {} satisfies OpenClawConfig,
      intent: { kind: "mutate", operations: [] },
    });

    expect(configMocks.replaceConfigFileWithIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        baseHash: "missing-config-revision",
        nextConfig: {},
      }),
    );
  });

  it("preserves runtime-only shared auth fields absent from the secrets source", () => {
    const runtimeOverlay = {
      gateway: { auth: { mode: "token" as const, token: "runtime-token" } },
    };
    secretsMocks.activeSnapshot = {
      sourceConfig: {},
      config: {},
    };

    expect(
      didActiveSharedGatewayAuthChange({ fallbackPrev: runtimeOverlay, next: runtimeOverlay }),
    ).toBe(false);
  });

  it("preserves runtime-only siblings beside authored shared auth fields", () => {
    secretsMocks.activeSnapshot = {
      sourceConfig: { gateway: { auth: { mode: "token" } } },
      config: { gateway: { auth: { mode: "token" } } },
    };
    const runtimeConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "runtime-token" } },
    };

    expect(
      didActiveSharedGatewayAuthChange({ fallbackPrev: runtimeConfig, next: runtimeConfig }),
    ).toBe(false);
  });

  it("compares secret-expanded shared auth when the source owns the field", () => {
    secretsMocks.activeSnapshot = {
      sourceConfig: {
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "GATEWAY_TOKEN" },
          },
        },
      },
      config: { gateway: { auth: { mode: "token", token: "old-token" } } },
    };

    expect(
      didActiveSharedGatewayAuthChange({
        fallbackPrev: { gateway: { auth: { mode: "token", token: "runtime-overlay" } } },
        next: { gateway: { auth: { mode: "token", token: "new-token" } } },
      }),
    ).toBe(true);
  });
});
