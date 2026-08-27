import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const TEST_TIMEOUT_MS = 30_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "AFORA_STATE_DIR",
  "AFORA_CONFIG_PATH",
  "AFORA_SKIP_CHANNELS",
  "AFORA_SKIP_GMAIL_WATCHER",
  "AFORA_SKIP_CRON",
  "AFORA_SKIP_CANVAS_HOST",
  "AFORA_SKIP_BROWSER_CONTROL_SERVER",
  "AFORA_SKIP_PROVIDERS",
  "AFORA_TEST_MINIMAL_GATEWAY",
  "AFORA_BUNDLED_PLUGINS_DIR",
  "AFORA_DISABLE_BUNDLED_PLUGINS",
] as const;

async function setupTempHome() {
  const env = captureEnv([...ENV_KEYS]);
  const home = tempDirs.make("afora-rpc-models-");
  const stateDir = path.join(home, ".afora");
  const workspace = path.join(home, "workspace");
  const bundledPlugins = path.join(home, "empty-bundled-plugins");
  await Promise.all([
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(bundledPlugins, { recursive: true }),
  ]);
  setTestEnvValue("HOME", home);
  setTestEnvValue("USERPROFILE", home);
  setTestEnvValue("AFORA_STATE_DIR", stateDir);
  setTestEnvValue("AFORA_SKIP_CHANNELS", "1");
  setTestEnvValue("AFORA_SKIP_GMAIL_WATCHER", "1");
  setTestEnvValue("AFORA_SKIP_CRON", "1");
  setTestEnvValue("AFORA_SKIP_CANVAS_HOST", "1");
  setTestEnvValue("AFORA_SKIP_BROWSER_CONTROL_SERVER", "1");
  setTestEnvValue("AFORA_BUNDLED_PLUGINS_DIR", bundledPlugins);
  setTestEnvValue("AFORA_DISABLE_BUNDLED_PLUGINS", "1");
  delete process.env.AFORA_CONFIG_PATH;
  delete process.env.AFORA_SKIP_PROVIDERS;
  delete process.env.AFORA_TEST_MINIMAL_GATEWAY;
  return {
    configPath: path.join(stateDir, "afora.json"),
    env,
    home,
    workspace,
  };
}

describe("gateway RPC model catalog", () => {
  it(
    "returns configured public model metadata without provider internals",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const temp = await setupTempHome();
      const token = `rpc-models-${process.pid}`;
      const modelRef = "fixture/catalog-model";
      let started: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

      try {
        started = await startGatewayWithClient({
          cfg: {
            agents: {
              defaults: {
                workspace: temp.workspace,
                model: { primary: modelRef },
                models: { [modelRef]: { alias: "Catalog Alias" } },
              },
            },
            gateway: { auth: { mode: "token", token } },
            models: {
              mode: "replace",
              providers: {
                fixture: {
                  apiKey: "rpc-model-secret",
                  baseUrl: "http://127.0.0.1:9/v1",
                  models: [
                    {
                      id: "catalog-model",
                      name: "Catalog Model",
                      contextWindow: 8192,
                      reasoning: true,
                      compat: { supportsTools: true },
                    },
                  ],
                },
              },
            },
          },
          configPath: temp.configPath,
          token,
          clientDisplayName: "rpc-models-reader",
        });

        const payload = (await started.client.request("models.list", {
          view: "configured",
        })) as {
          models: Array<Record<string, unknown>>;
        };
        expect(payload.models).toEqual([
          expect.objectContaining({
            alias: "Catalog Alias",
            contextWindow: 8192,
            id: "catalog-model",
            name: "Catalog Model",
            provider: "fixture",
            reasoning: true,
            supportsTools: true,
          }),
        ]);
        const model = payload.models[0] ?? {};
        expect(model).not.toHaveProperty("agentRuntime");
        expect(model).not.toHaveProperty("apiKey");
        expect(model).not.toHaveProperty("baseUrl");
        expect(JSON.stringify(payload)).not.toContain("rpc-model-secret");

        await expect(started.client.request("models.list", { unexpected: true })).rejects.toThrow(
          /invalid models\.list params/i,
        );
      } finally {
        try {
          if (started) {
            await disconnectGatewayClient(started.client).catch(() => undefined);
            await started.server.close({ reason: "gateway RPC model catalog proof complete" });
          }
        } finally {
          temp.env.restore();
        }
      }
    },
  );
});
