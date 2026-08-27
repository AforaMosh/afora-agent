// Npm Telegram Live tests cover npm telegram live script behavior.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { testing } from "../../scripts/e2e/npm-telegram-live-runner.ts";
import { privateLocalOnlyPluginSdkEntrypoints } from "../../scripts/lib/plugin-sdk-entries.mts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_SCRIPT_PATH = path.resolve(TEST_DIR, "../../scripts/e2e/npm-telegram-live-docker.sh");
const PREPARE_PACKAGE_PATH = path.resolve(
  TEST_DIR,
  "../../scripts/e2e/lib/npm-telegram-live/prepare-package.mts",
);
const tempRoots: string[] = [];

function mkTempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "afora-npm-telegram-live-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("package Telegram live Docker E2E", () => {
  it("supports npm-specific Convex credential aliases", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain("AFORA_NPM_TELEGRAM_CREDENTIAL_SOURCE");
    expect(script).toContain("AFORA_NPM_TELEGRAM_CREDENTIAL_ROLE");
    expect(script).toContain('docker_env+=(-e AFORA_QA_CREDENTIAL_SOURCE="$credential_source")');
    expect(script).toContain('docker_env+=(-e AFORA_QA_CREDENTIAL_ROLE="$credential_role")');
  });

  it("defaults CI runs to Convex when broker credentials are present", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'if [ -n "${CI:-}" ] && [ -n "${AFORA_QA_CONVEX_SITE_URL:-}" ]; then',
    );
    expect(script).toContain("AFORA_QA_CONVEX_SECRET_CI");
    expect(script).toContain("AFORA_QA_CONVEX_SECRET_MAINTAINER");
    expect(script).toContain('printf "convex"');
  });

  it("installs the package candidate before forwarding runtime secrets", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    const installRunStart = script.indexOf('echo "Running package Telegram live Docker E2E');
    const installRunEnd = script.indexOf("# Mount the trusted current-source QA harness");
    const installRun = script.slice(installRunStart, installRunEnd);

    expect(installRunStart).toBeGreaterThanOrEqual(0);
    expect(installRunEnd).toBeGreaterThan(installRunStart);
    expect(installRun).toContain(
      '-e AFORA_E2E_NPM_INSTALL_TIMEOUT="${AFORA_E2E_NPM_INSTALL_TIMEOUT:-600s}"',
    );
    expect(installRun).toContain(
      '"$timeout_bin" --kill-after=30s "$npm_install_timeout" npm install -g "$install_source" --no-fund --no-audit',
    );
    expect(installRun).toContain("elif command -v gtimeout >/dev/null 2>&1; then");
    expect(installRun).toContain('timeout_bin="gtimeout"');
    expect(installRun).toContain(
      'echo "timeout or gtimeout is required for AFORA_E2E_NPM_INSTALL_TIMEOUT=$npm_install_timeout" >&2',
    );
    expect(installRun).toContain('"$timeout_bin" --kill-after=1s 1s true >/dev/null 2>&1');
    expect(installRun).toContain(
      '"$timeout_bin" "$npm_install_timeout" npm install -g "$install_source" --no-fund --no-audit',
    );
    expect(installRun).toContain('npm install -g "$install_source" --no-fund --no-audit');
    expect(installRun).not.toContain(
      "running package install without AFORA_E2E_NPM_INSTALL_TIMEOUT",
    );
    expect(installRun).toContain('"${package_mount_args[@]}"');
    expect(installRun).not.toContain('"${docker_env[@]}"');
    expect(installRun).toContain(
      'run_logged_print_heartbeat "npm-telegram-package-install" 60 docker_e2e_docker_run_cmd run --rm',
    );
    expect(installRun).not.toContain("run_logged_print_heartbeat docker run --rm");
    expect(script).toContain(
      'run_logged_print_heartbeat "npm-telegram-live-suite" 60 docker_e2e_run_with_harness',
    );
    expect(script).not.toContain('cat "$run_log"');
    expect(script).toContain('"${docker_env[@]}"');
    expect(script).toContain(
      'if [ -z "$credential_role" ] && [ "$credential_source" = "convex" ]; then',
    );
    expect(script).toContain('credential_role="ci"');
    expect(script).toContain('credential_role="maintainer"');
  });

  it("bounds installed-package hot path Afora commands", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    const runtimeRunStart = script.indexOf("# Mount the trusted current-source QA harness");
    const runtimeRun = script.slice(runtimeRunStart);

    expect(runtimeRunStart).toBeGreaterThanOrEqual(0);
    expect(script).toContain(
      '-e AFORA_E2E_COMMAND_TIMEOUT="${AFORA_E2E_COMMAND_TIMEOUT:-300s}"',
    );
    expect(runtimeRun).toContain("source scripts/lib/afora-e2e-instance.sh");
    expect(runtimeRun).toContain('sut_command="/npm-global/bin/afora"');
    expect(runtimeRun).toContain('afora_e2e_run_command "$sut_command" --version');
    expect(runtimeRun).toContain('afora_e2e_run_command "$sut_command" onboard');
    expect(runtimeRun).toContain(
      'OPENAI_API_KEY="$hotpath_model_value" afora_e2e_run_command "$sut_command" onboard',
    );
    expect(runtimeRun).not.toContain("export OPENAI_API_KEY=");
    expect(runtimeRun).toContain('afora_e2e_run_command "$sut_command" channels add');
    expect(runtimeRun).toContain('afora_e2e_run_command "$sut_command" doctor --fix');
    expect(runtimeRun).toContain(
      'afora_e2e_run_command "$sut_command" doctor --non-interactive',
    );
    expect(runtimeRun).toContain('export AFORA_NPM_TELEGRAM_SUT_COMMAND="$sut_command"');
    expect(runtimeRun).toContain('afora_e2e_print_log "$file"');
    expect(runtimeRun).not.toContain("sed -n '1,220p'");
    expect(runtimeRun).not.toMatch(/^\s*afora (onboard|channels add|doctor )/mu);
  });

  it("isolates onboarding hot-path config from the live suite", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'runtime_home="$(mktemp -d "/tmp/afora-npm-telegram-runtime.XXXXXX")"',
    );
    expect(script).toContain(
      'hotpath_home="$(mktemp -d "/tmp/afora-npm-telegram-hotpath.XXXXXX")"',
    );
    expect(script).toContain('export HOME="$hotpath_home"');
    expect(script).toContain('export HOME="$runtime_home"');
  });

  it("fails fast after the first package Telegram scenario failure", () => {
    const runner = readFileSync(
      path.resolve(TEST_DIR, "../../scripts/e2e/npm-telegram-live-runner.ts"),
      "utf8",
    );

    expect(runner).toContain("failFast: true");
  });

  it("can install a resolved package tarball instead of a registry spec", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain("AFORA_NPM_TELEGRAM_PACKAGE_TGZ");
    expect(script).toContain("AFORA_CURRENT_PACKAGE_TGZ");
    expect(script).toContain('-e AFORA_QA_PACKAGE_SOURCE="$package_install_source"');
    expect(script).toContain('-e AFORA_QA_PACKAGE_SOURCE_KIND="$package_source_kind"');
    expect(script).toContain("AFORA_QA_PACKAGE_SOURCE_SHA");
    expect(script).toContain(
      'package_mount_args=(-v "$resolved_package_tgz:$package_install_source:ro")',
    );
    expect(script).toContain('validate_afora_package_spec "$PACKAGE_SPEC"');
    expect(script.indexOf('if [ -n "$resolved_package_tgz" ]; then')).toBeLessThan(
      script.indexOf('validate_afora_package_spec "$PACKAGE_SPEC"'),
    );
  });

  it("installs prepared root and companion tarballs through an exact local registry", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain("AFORA_NPM_TELEGRAM_PACKAGE_DIR");
    expect(script).toContain('package_source_kind="prepared-package-set"');
    expect(script).toContain('package_install_source="afora@$(read_package_version');
    expect(script).toContain('-v "$resolved_package_dir:/package-under-test:ro"');
    expect(script).toContain(
      '-v "$ROOT_DIR/scripts/lib/bounded-response.mjs:/tmp/lib/bounded-response.mjs:ro"',
    );
    expect(script).toContain(
      '-v "$ROOT_DIR/scripts/e2e/lib/plugins/npm-registry-server.mjs:/tmp/afora-e2e/lib/plugins/npm-registry-server.mjs:ro"',
    );
    expect(script).toContain("AFORA_NPM_TELEGRAM_PACKAGE_SET");
    expect(script).toContain("node /tmp/afora-e2e/lib/plugins/npm-registry-server.mjs");
    expect(script).toContain("AFORA_NPM_REGISTRY_UPSTREAM=https://registry.npmjs.org");
    expect(script).toContain('export NPM_CONFIG_REGISTRY="$registry_url"');
  });

  it("keeps live Docker artifacts isolated by default", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'RUN_ID="${AFORA_NPM_TELEGRAM_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"',
    );
    expect(script).toContain(
      'OUTPUT_DIR="${AFORA_NPM_TELEGRAM_OUTPUT_DIR:-.artifacts/qa-e2e/npm-telegram-live/$RUN_ID}"',
    );
    expect(script).toContain(
      'OUTPUT_DIR_CONTAINER_RELATIVE=".artifacts/qa-e2e/npm-telegram-live-output"',
    );
    expect(script).toContain('OUTPUT_DIR_CONTAINER="/app/$OUTPUT_DIR_CONTAINER_RELATIVE"');
    expect(script).toContain(
      '-e AFORA_NPM_TELEGRAM_OUTPUT_DIR="$OUTPUT_DIR_CONTAINER_RELATIVE"',
    );
    expect(script).not.toContain(
      'OUTPUT_DIR="${AFORA_NPM_TELEGRAM_OUTPUT_DIR:-.artifacts/qa-e2e/npm-telegram-live}"',
    );
  });

  it("uses unique direct-run output dirs by default", () => {
    const repoRoot = mkTempRoot();
    const firstDir = testing.resolvePackageTelegramOutputDir({}, repoRoot);
    const secondDir = testing.resolvePackageTelegramOutputDir({}, repoRoot);

    expect(path.dirname(firstDir)).toBe(path.join(repoRoot, ".artifacts", "qa-e2e"));
    expect(path.basename(firstDir)).toMatch(/^npm-telegram-live-[a-z0-9]+-[a-f0-9]{8}$/u);
    expect(secondDir).not.toBe(firstDir);
    expect(
      testing.resolvePackageTelegramOutputDir(
        { AFORA_NPM_TELEGRAM_OUTPUT_DIR: ".artifacts/custom" },
        repoRoot,
      ),
    ).toBe(".artifacts/custom");
  });

  it("keeps the installed Afora command as the package SUT", async () => {
    const prefix = mkTempRoot();
    const command = path.join(prefix, "bin", "afora");
    const harnessCommand = path.join(mkTempRoot(), "bin", "afora");
    mkdirSync(path.dirname(command), { recursive: true });
    mkdirSync(path.dirname(harnessCommand), { recursive: true });
    writeFileSync(command, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(harnessCommand, "#!/bin/sh\n", { mode: 0o755 });

    await expect(
      testing.resolveTrustedAforaCommand(command, {
        NPM_CONFIG_PREFIX: prefix,
      }),
    ).resolves.toEqual({
      executablePath: command,
      usePackagedPlugins: true,
    });
    await expect(
      testing.resolveTrustedAforaCommand(harnessCommand, {
        NPM_CONFIG_PREFIX: prefix,
      }),
    ).rejects.toThrow("AFORA_NPM_TELEGRAM_SUT_COMMAND must resolve inside NPM_CONFIG_PREFIX.");
  });

  it("mounts the QA taxonomy without exposing the repository root", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain('-v "$ROOT_DIR/taxonomy.yaml:/app/taxonomy.yaml:ro"');
    expect(script).not.toContain('-v "$ROOT_DIR:/app');
  });

  it("mounts configured output paths before entering the container", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    const dockerEnvStart = script.indexOf("docker_env=(");
    const dockerEnvEnd = script.indexOf(")\n\nforward_env_if_set", dockerEnvStart);
    const dockerEnv = script.slice(dockerEnvStart, dockerEnvEnd);

    expect(script).toContain('*) OUTPUT_DIR_HOST="$ROOT_DIR/$OUTPUT_DIR" ;;');
    expect(script).toContain('mkdir -p "$OUTPUT_DIR_HOST"');
    expect(script).toContain(
      'printf \'schema=1\\nexit_code=%s\\nlive_output=job_log\\n\' "$rc" > "$OUTPUT_DIR_HOST/run-metadata.txt"',
    );
    expect(script).toContain("trap cleanup EXIT");
    expect(dockerEnv).toContain(
      '-e AFORA_NPM_TELEGRAM_OUTPUT_DIR="$OUTPUT_DIR_CONTAINER_RELATIVE"',
    );
    expect(dockerEnv).not.toContain('-e AFORA_NPM_TELEGRAM_OUTPUT_DIR="$OUTPUT_DIR_CONTAINER"');
    expect(dockerEnv).not.toContain('-e AFORA_NPM_TELEGRAM_OUTPUT_DIR="$OUTPUT_DIR"');
    expect(script).toContain('-v "$OUTPUT_DIR_HOST:$OUTPUT_DIR_CONTAINER"');
  });

  it("uses the container temp root for Afora runtime scratch files", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    const dockerEnvStart = script.indexOf("docker_env=(");
    const dockerEnvEnd = script.indexOf(")\n\nforward_env_if_set", dockerEnvStart);
    const dockerEnv = script.slice(dockerEnvStart, dockerEnvEnd);

    expect(dockerEnvStart).toBeGreaterThanOrEqual(0);
    expect(dockerEnvEnd).toBeGreaterThan(dockerEnvStart);
    expect(dockerEnv).toContain("-e TMPDIR=/tmp");
  });

  it("forwards repeated RTT controls to the package Telegram live lane", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");

    expect(script).toContain("AFORA_NPM_TELEGRAM_RTT_SAMPLES");
    expect(script).toContain("AFORA_NPM_TELEGRAM_RTT_TIMEOUT_MS");
    expect(script).toContain("AFORA_NPM_TELEGRAM_RTT_MAX_FAILURES");
    expect(script).toContain("AFORA_NPM_TELEGRAM_RTT_CHECKS");
  });

  it("isolates the trusted private QA harness from the installed package candidate", () => {
    const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
    expect(script).toContain('cp "$ROOT_DIR/package.json" "$harness_package_json"');
    expect(script).toContain(
      'node --import tsx "$ROOT_DIR/scripts/e2e/lib/npm-telegram-live/prepare-package.mts" "$harness_package_json"',
    );
    expect(script).toContain('-v "$harness_package_json:/app/package.json:ro"');
    expect(script).toContain('-v "$ROOT_DIR/dist:/app/dist:ro"');
    expect(script).toContain('-v "$ROOT_DIR/node_modules:/trusted-harness/node_modules:ro"');
    expect(script).toContain('-v "$ROOT_DIR/packages:/app/packages:ro"');
    expect(script).toContain('-v "$ROOT_DIR/extensions:/app/extensions:ro"');
    expect(script).toContain('-v "$ROOT_DIR/taxonomy.yaml:/app/taxonomy.yaml:ro"');
    expect(script).toContain('-v "$ROOT_DIR/qa/scenarios:/app/qa/scenarios:ro"');
    expect(script).toContain("for dependency_dir in /trusted-harness/node_modules/*");
    expect(script).toContain("for workspace_dir in /app/packages/* /app/extensions/*");
    expect(script).toContain('link_harness_dependency "$workspace_dir" "$workspace_name"');
    expect(script).toContain("link_harness_dependency /app afora");
    expect(script).not.toContain('afora_package_dir="/npm-global/lib/node_modules/afora"');
    expect(script).not.toContain('cp "$afora_package_dir/package.json" /app/package.json');
    expect(script).not.toContain("/app/node_modules/afora/package.json");
    expect(script).not.toContain("link_installed_package_dependency");
  });

  it("adds private SDK exports only to the trusted harness manifest", () => {
    const root = mkTempRoot();
    const harnessManifestPath = path.join(root, "harness-package.json");
    const candidateManifestPath = path.join(root, "candidate-package.json");
    const existingGatewayExport = {
      types: "./existing/gateway-runtime.d.ts",
      default: "./existing/gateway-runtime.js",
    };
    writeFileSync(
      harnessManifestPath,
      `${JSON.stringify({
        name: "afora",
        exports: {
          "./kept": "./dist/kept.js",
          "./plugin-sdk/gateway-runtime": existingGatewayExport,
        },
      })}\n`,
    );
    writeFileSync(candidateManifestPath, '{"name":"candidate","exports":{}}\n');
    const candidateBefore = readFileSync(candidateManifestPath, "utf8");

    execFileSync(process.execPath, [PREPARE_PACKAGE_PATH, harnessManifestPath]);

    const prepared = JSON.parse(readFileSync(harnessManifestPath, "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(prepared.exports["./kept"]).toBe("./dist/kept.js");
    expect(prepared.exports["./plugin-sdk/gateway-runtime"]).toEqual(existingGatewayExport);
    expect(prepared.exports["./plugin-sdk/qa-runtime"]).toEqual({
      default: "./dist/plugin-sdk/qa-runtime.js",
    });
    expect(prepared.exports["./plugin-sdk/qa-lab"]).toEqual({
      default: "./dist/plugin-sdk/qa-lab.js",
    });
    for (const subpath of privateLocalOnlyPluginSdkEntrypoints) {
      expect(prepared.exports[`./plugin-sdk/${subpath}`]).toEqual({
        default: `./dist/plugin-sdk/${subpath}.js`,
      });
    }
    expect(readFileSync(candidateManifestPath, "utf8")).toBe(candidateBefore);
  });

  it("lets npm-specific credential aliases override shared QA env", () => {
    expect(
      testing.resolveCredentialSource({
        AFORA_NPM_TELEGRAM_CREDENTIAL_SOURCE: "convex",
        AFORA_QA_CREDENTIAL_SOURCE: "env",
      }),
    ).toBe("convex");
    expect(
      testing.resolveCredentialRole({
        AFORA_NPM_TELEGRAM_CREDENTIAL_ROLE: "ci",
        AFORA_QA_CREDENTIAL_ROLE: "maintainer",
      }),
    ).toBe("ci");
  });

  it("defaults package Telegram RTT for the normal package live lane", () => {
    expect(testing.resolveRttOptions({})).toEqual({
      scenarioId: "channel-canary",
      count: 20,
      timeoutMs: 30_000,
      maxFailures: 20,
    });
  });

  it("does not force default RTT onto focused non-RTT scenario runs", () => {
    expect(testing.resolveRttOptions({}, ["telegram-status-command"])).toBeUndefined();
  });

  it("maps repeated RTT env onto package Telegram live options", () => {
    expect(
      testing.resolveRttOptions({
        AFORA_NPM_TELEGRAM_RTT_SAMPLES: "7",
        AFORA_NPM_TELEGRAM_RTT_TIMEOUT_MS: "45000",
        AFORA_NPM_TELEGRAM_RTT_MAX_FAILURES: "2",
        AFORA_NPM_TELEGRAM_RTT_CHECKS: "channel-canary",
      }),
    ).toEqual({
      scenarioId: "channel-canary",
      count: 7,
      timeoutMs: 45_000,
      maxFailures: 2,
    });
  });

  it("builds a generic suite probe for the Telegram RTT lane", () => {
    const probe = testing.createRoundTripProbe(testing.resolveRttOptions({}));

    expect(probe).toMatchObject({
      scenarioId: "channel-canary",
      count: 20,
      timeoutMs: 30_000,
      markerPrefix: "QA-TELEGRAM-RTT",
      textPrefix: "@afora Telegram RTT check. Reply exactly: ",
      chainReplies: true,
      input: {
        conversation: { id: "telegram-rtt-room", kind: "group" },
      },
    });
  });

  it.each([
    {
      name: "promotes the default canary before taxonomy-backed release selection",
      env: {},
      requested: [],
      resolved: ["telegram-status-command"],
      expected: ["channel-canary", "telegram-status-command"],
    },
    {
      name: "keeps focused non-RTT selections unchanged",
      env: {},
      requested: ["telegram-status-command"],
      resolved: ["telegram-status-command"],
      expected: ["telegram-status-command"],
    },
    {
      name: "promotes an explicitly requested RTT canary",
      env: { AFORA_NPM_TELEGRAM_RTT_CHECKS: "channel-canary" },
      requested: ["telegram-status-command"],
      resolved: ["telegram-status-command"],
      expected: ["channel-canary", "telegram-status-command"],
    },
    {
      name: "does not duplicate an already selected RTT canary",
      env: {},
      requested: ["telegram-status-command", "channel-canary"],
      resolved: ["telegram-status-command", "channel-canary"],
      expected: ["channel-canary", "telegram-status-command"],
    },
  ])("$name", ({ env, requested, resolved, expected }) => {
    const options = testing.resolveRttOptions(env, requested);

    expect(testing.prioritizeRoundTripProbeScenario(resolved, options)).toEqual(expected);
  });

  it("rejects retired RTT scenario ids", () => {
    expect(() =>
      testing.resolveRttOptions({
        AFORA_NPM_TELEGRAM_RTT_CHECKS: "telegram-mentioned-message-reply",
      }),
    ).toThrow("unknown Telegram QA RTT check: telegram-mentioned-message-reply");
  });

  it("rejects invalid repeated RTT env", () => {
    expect(() =>
      testing.resolveRttOptions({
        AFORA_NPM_TELEGRAM_RTT_SAMPLES: "7samples",
      }),
    ).toThrow("invalid AFORA_NPM_TELEGRAM_RTT_SAMPLES: 7samples");
  });

  it.each(["fail", "skip", "skipped", "timeout"])(
    "fails package Telegram QA when a scenario has %s status",
    async (status) => {
      const summaryPath = path.join(mkTempRoot(), "qa-evidence.json");
      writeFileSync(
        summaryPath,
        JSON.stringify({
          kind: "afora.qa.evidence-summary",
          schemaVersion: 2,
          generatedAt: "2026-05-01T00:00:00.000Z",
          entries: [{ result: { status } }],
        }),
        "utf8",
      );

      await expect(
        testing.shouldFailPackageTelegramRun(
          { summaryPath },
          { AFORA_NPM_TELEGRAM_ALLOW_FAILURES: "" },
        ),
      ).resolves.toBe(true);
    },
  );

  it("passes package Telegram QA when every scenario passes", async () => {
    const summaryPath = path.join(mkTempRoot(), "qa-evidence.json");
    writeFileSync(
      summaryPath,
      JSON.stringify({
        kind: "afora.qa.evidence-summary",
        schemaVersion: 2,
        generatedAt: "2026-05-01T00:00:00.000Z",
        entries: [{ result: { status: "pass" } }],
      }),
      "utf8",
    );

    await expect(
      testing.shouldFailPackageTelegramRun(
        { summaryPath },
        { AFORA_NPM_TELEGRAM_ALLOW_FAILURES: "" },
      ),
    ).resolves.toBe(false);
  });

  it("does not read package Telegram summaries when failures are allowed", async () => {
    await expect(
      testing.shouldFailPackageTelegramRun(
        { summaryPath: path.join(mkTempRoot(), "missing-summary.json") },
        { AFORA_NPM_TELEGRAM_ALLOW_FAILURES: "1" },
      ),
    ).resolves.toBe(false);
  });
});
