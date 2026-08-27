// CLI JSON stdout E2E tests validate machine-readable CLI output.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "afora-agent/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";

function runSourceCli(tempHome: string, args: string[], envOverrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    AFORA_TEST_FAST: "1",
  };
  delete env.AFORA_HOME;
  delete env.AFORA_STATE_DIR;
  delete env.AFORA_CONFIG_PATH;
  delete env.VITEST;
  Object.assign(env, envOverrides);

  const entry = path.resolve(process.cwd(), "src/entry.ts");
  return spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
}

describe("cli json stdout contract", () => {
  it.each([
    {
      name: "routed config get",
      args: ["config", "get", "gateway.port", "--json"],
      overrides: {},
    },
    {
      name: "Commander config get",
      args: ["config", "get", "gateway.port", "--json"],
      overrides: { AFORA_DISABLE_ROUTE_FIRST: "1" },
    },
    {
      name: "Nix config get",
      args: ["config", "get", "gateway.port", "--json"],
      overrides: { AFORA_NIX_MODE: "1" },
    },
    { name: "config schema", args: ["config", "schema"], overrides: {} },
    {
      name: "Nix config schema",
      args: ["config", "schema"],
      overrides: { AFORA_NIX_MODE: "1" },
    },
    { name: "config validate", args: ["config", "validate", "--json"], overrides: {} },
    {
      name: "Nix config validate",
      args: ["config", "validate", "--json"],
      overrides: { AFORA_NIX_MODE: "1" },
    },
  ])("does not initialize shared SQLite for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "read-only-state");
        const configPath = path.join(tempHome, "read-only-afora.json");
        await fs.writeFile(
          configPath,
          `${JSON.stringify({ gateway: { mode: "local", port: 18789 } })}\n`,
          "utf8",
        );

        const result = runSourceCli(tempHome, testCase.args, {
          AFORA_CONFIG_PATH: configPath,
          AFORA_STATE_DIR: stateDir,
          ...testCase.overrides,
        });

        expect(result.status, result.stderr).toBe(0);
        expect(() => JSON.parse(result.stdout)).not.toThrow();
        await expect(
          fs.access(path.join(stateDir, "state", "afora.sqlite")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { prefix: "afora-read-only-config-e2e-" },
    );
  });

  it.each([
    { name: "routed malformed config get", overrides: {} },
    {
      name: "Commander malformed config get",
      overrides: { AFORA_DISABLE_ROUTE_FIRST: "1" },
    },
  ])("returns actionable JSON without creating state for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "read-only-state");
        const configPath = path.join(tempHome, "read-only-afora.json");
        await fs.writeFile(configPath, "{}\n", "utf8");

        const result = runSourceCli(
          tempHome,
          ["config", "get", "gateway.__proto__.token", "--json"],
          {
            AFORA_CONFIG_PATH: configPath,
            AFORA_STATE_DIR: stateDir,
            ...testCase.overrides,
          },
        );

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: {
            type: "cli_error",
            message: expect.stringContaining("Invalid path segment: __proto__"),
          },
        });
        expect(result.stderr).toBe("");
        await expect(
          fs.access(path.join(stateDir, "state", "afora.sqlite")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { prefix: "afora-read-only-invalid-config-e2e-" },
    );
  });

  it.each([
    { name: "routed invalid config get", overrides: {} },
    {
      name: "Commander invalid config get",
      overrides: { AFORA_DISABLE_ROUTE_FIRST: "1" },
    },
  ])("reports invalid configuration as JSON without creating state for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "read-only-state");
        const configPath = path.join(tempHome, "read-only-afora.json");
        await fs.writeFile(
          configPath,
          `${JSON.stringify({ gateway: { bind: "not-a-supported-mode" } })}\n`,
          "utf8",
        );

        const result = runSourceCli(tempHome, ["config", "get", "gateway.port", "--json"], {
          AFORA_CONFIG_PATH: configPath,
          AFORA_STATE_DIR: stateDir,
          ...testCase.overrides,
        });

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: {
            type: "cli_error",
            message: expect.stringContaining("Afora config is invalid"),
          },
          issues: expect.arrayContaining([
            expect.objectContaining({ path: "gateway.bind", message: expect.any(String) }),
          ]),
        });
        expect(result.stderr).toBe("");
        await expect(
          fs.access(path.join(stateDir, "state", "afora.sqlite")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { prefix: "afora-read-only-invalid-snapshot-e2e-" },
    );
  });

  it.each([
    { name: "default service", inheritedProfile: undefined, inheritedStateName: ".afora" },
    { name: "named service", inheritedProfile: "main", inheritedStateName: ".afora-main" },
  ])("resolves the requested profile from inherited $name state", async (inherited) => {
    await withTempHome(
      async (tempHome) => {
        const inheritedStateDir = path.join(tempHome, inherited.inheritedStateName);
        const result = runSourceCli(tempHome, ["--profile", "work", "config", "file"], {
          AFORA_PROFILE: inherited.inheritedProfile,
          AFORA_STATE_DIR: inheritedStateDir,
          AFORA_CONFIG_PATH: path.join(inheritedStateDir, "afora.json"),
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(path.join(tempHome, ".afora-work", "afora.json"));
        await expect(fs.access(path.join(tempHome, ".afora-work"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { prefix: "afora-profile-isolation-e2e-" },
    );
  });

  it("keeps default-profile exec approvals untouched for a scratch-state config query", async () => {
    await withTempHome(
      async (tempHome) => {
        const defaultStateDir = path.join(tempHome, ".afora");
        const scratchStateDir = path.join(tempHome, "scratch-state");
        const approvalsPath = path.join(defaultStateDir, "exec-approvals.json");
        const approvals = '{"version":1,"approvals":{"demo":true}}\n';
        await fs.mkdir(defaultStateDir, { recursive: true });
        await fs.mkdir(scratchStateDir, { recursive: true });
        await fs.writeFile(approvalsPath, approvals, "utf8");

        const result = runSourceCli(tempHome, ["config", "file"], {
          AFORA_STATE_DIR: scratchStateDir,
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(path.join(scratchStateDir, "afora.json"));
        await expect(fs.readFile(approvalsPath, "utf8")).resolves.toBe(approvals);
        await expect(fs.access(`${approvalsPath}.migrated`)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          fs.access(path.join(scratchStateDir, "exec-approvals.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          fs.access(path.join(scratchStateDir, "state", "afora.sqlite")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      },
      { prefix: "afora-read-only-state-e2e-" },
    );
  });

  it("keeps `update status --json` stdout parseable even with legacy doctor preflight inputs", async () => {
    await withTempHome(
      async (tempHome) => {
        const legacyDir = path.join(tempHome, ".clawdbot");
        await fs.mkdir(legacyDir, { recursive: true });
        await fs.writeFile(path.join(legacyDir, "clawdbot.json"), "{}", "utf8");

        const result = runSourceCli(tempHome, ["update", "status", "--json", "--timeout", "1"]);

        expect(result.status).toBe(0);
        const stdout = result.stdout.trim();
        expect(stdout.length).toBeGreaterThan(0);
        const parsed = JSON.parse(stdout) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(`Expected JSON object stdout, got: ${stdout}`);
        }
        expect(Object.keys(parsed).toSorted((a, b) => a.localeCompare(b))).toEqual([
          "availability",
          "channel",
          "update",
        ]);
        expect(stdout).not.toContain("Doctor warnings");
        expect(stdout).not.toContain("Doctor changes");
        expect(stdout).not.toContain("Config invalid");
      },
      { prefix: "afora-json-e2e-" },
    );
  });

  it("rejects an explicitly empty update status timeout before emitting JSON", async () => {
    await withTempHome(
      async (tempHome) => {
        const result = runSourceCli(tempHome, ["update", "status", "--json", "--timeout", ""]);

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: "--timeout must be a positive integer (seconds)",
          },
        });
        expect(result.stderr).toContain("--timeout must be a positive integer (seconds)");
      },
      { prefix: "afora-update-empty-timeout-e2e-" },
    );
  });

  it("returns one canonical document for a command that previously failed on stderr only", async () => {
    await withTempHome(
      async (tempHome) => {
        const missingArchive = path.join(tempHome, "missing-backup.tar.gz");
        const result = runSourceCli(tempHome, ["backup", "verify", missingArchive, "--json"]);

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: expect.stringContaining("missing-backup.tar.gz"),
          },
        });
      },
      { prefix: "afora-json-failure-e2e-" },
    );
  });

  it("keeps Commander parse failures machine-readable in JSON mode", async () => {
    await withTempHome(
      async (tempHome) => {
        const result = runSourceCli(tempHome, [
          "config",
          "get",
          "gateway.port",
          "--json",
          "--not-a-real-option",
        ]);

        expect(result.status).toBe(1);
        const payload = JSON.parse(result.stdout) as {
          ok: boolean;
          error: { type: string; message: string };
        };
        expect(payload).toMatchObject({
          ok: false,
          error: {
            type: "cli_error",
            message: expect.stringContaining("--not-a-real-option"),
          },
        });
        expect(payload.error.message).not.toMatch(/^error:/i);
        expect(result.stderr).toContain("--not-a-real-option");
      },
      { prefix: "afora-json-parse-failure-e2e-" },
    );
  });

  it.each([
    {
      name: "unknown root",
      args: ["pairng"],
      diagnostic: 'Afora does not know the command "pairng".',
      suggestion: "afora pairing",
    },
    {
      name: "unknown nested command",
      args: ["sessions", "lst"],
      diagnostic: 'Afora sessions has no command "lst".',
      suggestion: "afora sessions list",
    },
    {
      name: "unknown nested command with a later argument",
      args: ["config", "gett", "gateway.port"],
      diagnostic: 'Afora config has no command "gett".',
      suggestion: "afora config get",
    },
    {
      name: "unknown root before help",
      args: ["pairng", "--help"],
      diagnostic: 'Afora does not know the command "pairng".',
      suggestion: "afora pairing",
    },
  ])("renders $name as actionable guidance", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const result = runSourceCli(tempHome, testCase.args);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(testCase.diagnostic);
        expect(result.stderr).toContain(`Did you mean this?\n  ${testCase.suggestion}`);
        expect(result.stderr.split(testCase.diagnostic)).toHaveLength(2);
        expect(result.stderr.split(testCase.suggestion)).toHaveLength(2);
        expect(result.stderr).not.toContain("The CLI command failed.");
        expect(result.stderr).not.toContain("Could not start the CLI.");
        expect(result.stderr).not.toContain("AFORA_DEBUG");
        expect(result.stderr).not.toContain("afora doctor");
        if (testCase.args.includes("--help")) {
          expect(result.stdout).not.toContain("Usage: afora [options] [command]");
        }
      },
      { prefix: "afora-unknown-command-e2e-" },
    );
  });

  it.each([
    {
      name: "unknown root",
      args: ["pairng", "--json"],
      diagnostic: 'Afora does not know the command "pairng".',
      suggestion: "afora pairing",
    },
    {
      name: "unknown nested command",
      args: ["sessions", "lst", "--json"],
      diagnostic: 'Afora sessions has no command "lst".',
      suggestion: "afora sessions list",
    },
  ])("reports $name once with structured JSON guidance", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const result = runSourceCli(tempHome, testCase.args);

        expect(result.status).toBe(1);
        const payload = JSON.parse(result.stdout) as {
          ok: boolean;
          error: { type: string; message: string };
        };
        expect(payload.ok).toBe(false);
        expect(payload.error.type).toBe("cli_error");
        expect(payload.error.message).toContain(testCase.diagnostic);
        expect(payload.error.message).not.toMatch(/^error:/i);
        expect(payload.error.message).toContain(`Did you mean this?\n  ${testCase.suggestion}`);
        expect(payload.error.message).not.toContain("AFORA_DEBUG");
        expect(payload.error.message).not.toContain("afora doctor");
        expect(result.stderr).toContain(testCase.diagnostic);
        expect(result.stderr).toContain(`Did you mean this?\n  ${testCase.suggestion}`);
        expect(result.stderr.split(testCase.diagnostic)).toHaveLength(2);
        expect(result.stderr.split(testCase.suggestion)).toHaveLength(2);
        expect(result.stderr).not.toContain("The CLI command failed.");
        expect(result.stderr).not.toContain("Could not start the CLI.");
        expect(result.stderr).not.toContain("AFORA_DEBUG");
        expect(result.stderr).not.toContain("afora doctor");
      },
      { prefix: "afora-unknown-command-json-e2e-" },
    );
  });

  it("keeps parse-error JSON free of terminal controls when color is forced", async () => {
    await withTempHome(
      async (tempHome) => {
        const result = runSourceCli(tempHome, ["sessions", "lst", "--json"], {
          FORCE_COLOR: "1",
        });

        expect(result.status).toBe(1);
        const payload = JSON.parse(result.stdout) as {
          error: { message: string };
        };
        expect(payload.error.message).toBe(
          'Afora sessions has no command "lst".\nDid you mean this?\n  afora sessions list\nTry: afora sessions --help\nDocs: https://docs.afora.ai/cli',
        );
        expect(payload.error.message).not.toMatch(/[\u001B\u0007]/u);
        expect(result.stdout).not.toContain("\\u001b");
        expect(result.stderr).toContain("\u001B[");
      },
      { prefix: "afora-unknown-command-color-json-e2e-" },
    );
  });

  it("keeps representative success payload bytes unchanged", async () => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "afora.json");
        await fs.writeFile(configPath, '{"gateway":{"port":28789}}\n', "utf8");
        const env = { AFORA_CONFIG_PATH: configPath };

        const getResult = runSourceCli(tempHome, ["config", "get", "gateway.port", "--json"], env);
        const validateResult = runSourceCli(tempHome, ["config", "validate", "--json"], env);

        expect(getResult.status, getResult.stderr).toBe(0);
        expect(getResult.stdout).toBe("28789\n");
        expect(validateResult.status, validateResult.stderr).toBe(0);
        expect(validateResult.stdout).toBe(
          `${JSON.stringify({ valid: true, path: configPath, warnings: [] })}\n`,
        );
      },
      { prefix: "afora-json-success-bytes-e2e-" },
    );
  });

  it("keeps `config schema` stdout parseable at debug log level", async () => {
    await withTempHome(
      async (tempHome) => {
        const result = runSourceCli(tempHome, ["config", "schema"], {
          AFORA_LOG_LEVEL: "debug",
        });

        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout) as {
          properties?: Record<string, unknown>;
        };
        expect(parsed.properties?.$schema).toEqual({ type: "string" });
        expect(result.stdout).not.toContain("possibly sensitive key found");
        expect(result.stderr).not.toContain("possibly sensitive key found");
      },
      { prefix: "afora-config-schema-json-e2e-" },
    );
  });

  it("keeps `config validate --json` stdout parseable at debug log level", async () => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "afora.json");
        await fs.writeFile(configPath, "{}", "utf8");
        const result = runSourceCli(tempHome, ["config", "validate", "--json"], {
          AFORA_CONFIG_PATH: configPath,
          AFORA_LOG_LEVEL: "debug",
        });

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          valid: true,
          path: configPath,
        });
        expect(result.stdout).not.toContain("possibly sensitive key found");
      },
      { prefix: "afora-config-validate-json-e2e-" },
    );
  });

  it("returns structured Doctor lint output when llama.cpp is not bundled", async () => {
    await withTempHome(
      async (tempHome) => {
        const bundledPluginsDir = path.join(tempHome, "packaged-extensions");
        const memoryCoreDir = path.join(bundledPluginsDir, "memory-core");
        await fs.mkdir(memoryCoreDir, { recursive: true });
        await fs.writeFile(
          path.join(memoryCoreDir, "api.js"),
          [
            "export function registerMemoryCoreDoctorChecks(host) {",
            "  host.registerHealthCheck({",
            '    id: "memory-core/managed-local-embedding-setup",',
            '    kind: "plugin",',
            '    source: "memory-core",',
            '    description: "packaged Memory Core readiness fixture",',
            "    async detect() { return []; },",
            "  });",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );

        const result = runSourceCli(
          tempHome,
          [
            "doctor",
            "--lint",
            "--only",
            "memory-core/managed-local-embedding-setup",
            "--severity-min",
            "error",
            "--json",
          ],
          {
            AFORA_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
            AFORA_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: true,
          checksRun: 1,
          findings: [],
        });
      },
      { prefix: "afora-doctor-packaged-json-e2e-" },
    );
  });
});
