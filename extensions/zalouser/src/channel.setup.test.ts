// Zalouser tests cover channel.setup plugin behavior.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPluginSetupWizardStatus } from "afora-agent/plugin-sdk/plugin-test-runtime";
import { withEnvAsync } from "afora-agent/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import "./zalo-js.test-mocks.js";
import { zalouserSetupPlugin } from "./setup-test-helpers.js";

const zalouserSetupGetStatus = createPluginSetupWizardStatus(zalouserSetupPlugin);

describe("zalouser setup plugin", () => {
  it("builds setup status without an initialized runtime", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "afora-zalouser-setup-"));

    try {
      await withEnvAsync({ AFORA_STATE_DIR: stateDir }, async () => {
        const status = await zalouserSetupGetStatus({
          cfg: {},
          accountOverrides: {},
        });
        expect(status.channel).toBe("zalouser");
        expect(status.configured).toBe(false);
        expect(status.statusLines).toEqual(["Zalo Personal: needs QR login"]);
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
