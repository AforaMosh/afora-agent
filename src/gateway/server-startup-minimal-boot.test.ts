// Minimal-gateway boot smoke: guards the startup path the Control UI e2e suites
// depend on. Bundled plugins stay enabled on purpose — disabling them (as other
// gateway boot tests do) hides startup work that materializes plugin runtime,
// which is exactly how a startup stall shipped green while hanging every
// ui-e2e suite that boots a minimal test gateway.
import { afterEach, describe, expect, it } from "vitest";
import { resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createAforaTestState } from "../test-utils/afora-test-state.js";
import { getFreePort } from "../test-utils/ports.js";

// Local boot completes in ~10s; the budget only buys headroom for loaded CI
// runners. A stall exhausts it and fails in the gateway lane instead of first
// surfacing on unrelated UI PRs.
const BOOT_BUDGET_MS = 90_000;

afterEach(() => {
  resetConfigRuntimeState();
  clearPluginMetadataLifecycleCaches();
});

describe("gateway minimal boot smoke", () => {
  it("suppresses ambient channel triggers when the server option is omitted", async () => {
    const port = await getFreePort();
    const state = await createAforaTestState({
      label: "gateway-bootstrap-ambient-default",
      layout: "home",
      env: {
        AFORA_SKIP_BROWSER_CONTROL_SERVER: "1",
        AFORA_SKIP_CANVAS_HOST: "1",
        AFORA_SKIP_CHANNELS: "1",
        AFORA_SKIP_CRON: "1",
        AFORA_SKIP_GMAIL_WATCHER: "1",
        AFORA_SKIP_PROVIDERS: "1",
        AFORA_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const token = "gateway-bootstrap-test-token";
    await state.writeConfig({ gateway: { auth: { mode: "token", token } }, plugins: {} });
    state.applyEnv();

    try {
      const { prepareGatewayServerBootstrap } = await import("./server-startup-bootstrap.js");
      const log = createSubsystemLogger("gateway/bootstrap-test");
      const bootstrap = await prepareGatewayServerBootstrap({
        port,
        opts: {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        },
        log,
        logSecrets: log,
        loadWorkerEnvironmentStartupModule: async () =>
          await import("./server-worker-environment-startup.js"),
        formatRuntimeGatewayAuthTokenWarning: () => "unused",
      });

      expect(bootstrap.ambientEnvTriggers).toBe("suppress");
    } finally {
      await state.cleanup();
    }
  });

  it("boots a minimal test gateway within budget", { timeout: BOOT_BUDGET_MS }, async () => {
    const port = await getFreePort();
    const state = await createAforaTestState({
      label: "gateway-minimal-boot-smoke",
      layout: "home",
      env: {
        AFORA_GATEWAY_PASSWORD: undefined,
        AFORA_GATEWAY_TOKEN: undefined,
        AFORA_SKIP_BROWSER_CONTROL_SERVER: "1",
        AFORA_SKIP_CANVAS_HOST: "1",
        AFORA_SKIP_CHANNELS: "1",
        AFORA_SKIP_CRON: "1",
        AFORA_SKIP_GMAIL_WATCHER: "1",
        AFORA_SKIP_PROVIDERS: "1",
        AFORA_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const token = "gateway-minimal-boot-smoke-token";
    await state.writeConfig({
      gateway: {
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        port,
      },
    });
    state.applyEnv();
    try {
      const { startGatewayServer } = await import("./server.js");
      const server = await startGatewayServer(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      expect(server).toBeTruthy();
      await server.close({ reason: "minimal boot smoke complete" });
    } finally {
      await state.cleanup();
    }
  });
});
