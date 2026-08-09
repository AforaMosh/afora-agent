import { describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

const refreshPreparedModelRuntimeSnapshots = vi.hoisted(() =>
  vi.fn(() => new Promise<void>(() => {})),
);

vi.mock("../agents/prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-runtime.js")>()),
  refreshPreparedModelRuntimeSnapshots,
}));

describe("gateway chat metadata lifecycle", () => {
  test("minimal test gateway attach skips the startup runtime build", async () => {
    const lifecycle = await createGatewayChatMetadataLifecycle({
      getConfig: () => ({}) as OpenClawConfig,
      minimalTestGateway: true,
      log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
    });
    const sidecars: GatewayPostReadySidecarHandle[] = [];
    // Minimal gateways register no refresh listeners, so there is no listener-registration
    // race for a catch-up refresh to close. Awaiting one would force the full prepared
    // model runtime build at startup, which the never-resolving mock turns into a hang.
    await expect(
      Promise.race([
        lifecycle.attachContext({} as GatewayRequestContext, sidecars).then(() => "attached"),
        new Promise((resolve) => setTimeout(() => resolve("timed out"), 2_000)),
      ]),
    ).resolves.toBe("attached");
    expect(refreshPreparedModelRuntimeSnapshots).not.toHaveBeenCalled();
    expect(sidecars).toHaveLength(0);
  });
});
