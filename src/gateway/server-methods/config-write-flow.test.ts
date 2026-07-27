import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const configMocks = vi.hoisted(() => ({
  replaceConfigFileWithIntent: vi.fn(),
  resolveConfigSnapshotHash: vi.fn(),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    replaceConfigFileWithIntent: configMocks.replaceConfigFileWithIntent,
    resolveConfigSnapshotHash: configMocks.resolveConfigSnapshotHash,
  };
});

import { commitGatewayConfigWrite } from "./config-write-flow.js";

describe("commitGatewayConfigWrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.resolveConfigSnapshotHash.mockReturnValue("missing-config-revision");
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
});
