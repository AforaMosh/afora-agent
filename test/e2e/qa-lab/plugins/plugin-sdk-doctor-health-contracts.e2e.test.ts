// Covers public Plugin SDK doctor and health contracts through real CLI commands.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { createTempDirTracker } from "../../../helpers/temp-dir.js";

const PLUGIN_ID = "qa-doctor-contract";
const POLICY_CHECK_ID = "policy/policy-jsonc-missing";
const MIGRATION_MESSAGE = "Migrated qa-doctor-contract legacyEndpoint to endpoint.";
const tempDirs = createTempDirTracker();

let instance: OpenClawTestInstance | undefined;

function writeFixturePluginSource(): string {
  return `
const { asObjectRecord } = require("openclaw/plugin-sdk/runtime-doctor");

module.exports = {
  normalizeCompatibilityConfig({ cfg }) {
    const root = asObjectRecord(cfg);
    const plugins = asObjectRecord(root?.plugins);
    const entries = asObjectRecord(plugins?.entries);
    const entry = asObjectRecord(entries?.[${JSON.stringify(PLUGIN_ID)}]);
    const config = asObjectRecord(entry?.config);
    if (!root || !plugins || !entries || !entry || !config || !Object.hasOwn(config, "legacyEndpoint")) {
      return { config: cfg, changes: [] };
    }

    const nextConfig = { ...config, endpoint: config.legacyEndpoint };
    delete nextConfig.legacyEndpoint;
    return {
      config: {
        ...root,
        plugins: {
          ...plugins,
          entries: {
            ...entries,
            [${JSON.stringify(PLUGIN_ID)}]: { ...entry, config: nextConfig },
          },
        },
      },
      changes: [${JSON.stringify(MIGRATION_MESSAGE)}],
    };
  },
};
`;
}

async function writeFixturePlugin(): Promise<string> {
  const pluginRoot = tempDirs.make("openclaw-plugin-sdk-doctor-health-");
  await fs.writeFile(
    path.join(pluginRoot, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: PLUGIN_ID,
        name: "QA Doctor Contract",
        version: "0.0.0-test",
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            endpoint: { type: "string" },
            legacyEndpoint: { type: "string" },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(pluginRoot, "index.cjs"), "module.exports = { register() {} };\n");
  await fs.writeFile(path.join(pluginRoot, "doctor-contract-api.cjs"), writeFixturePluginSource());
  return pluginRoot;
}

function parseLintResult(stdout: string): {
  ok: boolean;
  checksRun: number;
  findings: Array<Record<string, unknown>>;
} {
  return JSON.parse(stdout) as {
    ok: boolean;
    checksRun: number;
    findings: Array<Record<string, unknown>>;
  };
}

afterEach(async () => {
  await instance?.cleanup();
  instance = undefined;
  tempDirs.cleanup();
});

describe("plugin SDK doctor and health contracts", () => {
  it("runs manifest doctor repair and structured health checks through real CLI commands", async () => {
    const pluginRoot = await writeFixturePlugin();
    instance = await createOpenClawTestInstance({
      name: "plugin-sdk-doctor-health",
      config: {
        agents: {
          defaults: {
            workspace: tempDirs.make("openclaw-plugin-sdk-doctor-workspace-"),
          },
        },
        plugins: {
          allow: [PLUGIN_ID, "policy"],
          load: { paths: [pluginRoot] },
          entries: {
            [PLUGIN_ID]: {
              enabled: true,
              config: { legacyEndpoint: "https://example.invalid/doctor" },
            },
            policy: {
              enabled: true,
              config: { enabled: true },
            },
          },
        },
      },
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
    });

    const lintBefore = await instance.cli([
      "doctor",
      "--lint",
      "--json",
      "--only",
      POLICY_CHECK_ID,
    ]);
    expect(lintBefore.code, lintBefore.stderr).toBe(1);
    expect(parseLintResult(lintBefore.stdout)).toMatchObject({
      ok: false,
      checksRun: 1,
      findings: [
        {
          checkId: POLICY_CHECK_ID,
          severity: "warning",
          path: "policy.jsonc",
        },
      ],
    });

    const repair = await instance.cli(["doctor", "--fix", "--yes", "--non-interactive"], {
      timeoutMs: 120_000,
    });
    expect(repair.code, repair.stderr).toBe(0);
    expect(repair.stdout).toContain(MIGRATION_MESSAGE);

    const repairedConfig = JSON.parse(await fs.readFile(instance.configPath, "utf8")) as {
      plugins?: { entries?: Record<string, { config?: Record<string, unknown> }> };
    };
    expect(repairedConfig.plugins?.entries?.[PLUGIN_ID]?.config).toEqual({
      endpoint: "https://example.invalid/doctor",
    });

    const secondRepair = await instance.cli(["doctor", "--fix", "--yes", "--non-interactive"], {
      timeoutMs: 120_000,
    });
    expect(secondRepair.code, secondRepair.stderr).toBe(0);
    expect(secondRepair.stdout).not.toContain(MIGRATION_MESSAGE);

    const workspaceDir = (
      repairedConfig as {
        agents?: { defaults?: { workspace?: string } };
      }
    ).agents?.defaults?.workspace;
    expect(workspaceDir).toBeTruthy();
    await fs.writeFile(path.join(workspaceDir!, "policy.jsonc"), "{}\n", "utf8");

    const lintAfter = await instance.cli(["doctor", "--lint", "--json", "--only", POLICY_CHECK_ID]);
    expect(lintAfter.code, lintAfter.stderr).toBe(0);
    expect(parseLintResult(lintAfter.stdout)).toMatchObject({
      ok: true,
      checksRun: 1,
      findings: [],
    });
  });
});
