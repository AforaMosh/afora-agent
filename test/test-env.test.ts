// Test environment tests validate shared env setup helpers.
import fs from "node:fs";
import path from "node:path";
import { importFreshModule } from "afora-agent/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../src/agents/auth-profiles/sqlite.js";
import { closeAforaAgentDatabaseByPath } from "../src/state/afora-agent-db.js";
import { closeAforaStateDatabaseByPath } from "../src/state/afora-state-db.js";
import { resolveAforaStateSqlitePath } from "../src/state/afora-state-db.paths.js";
import { deleteTestEnvValue, setTestEnvValue } from "../src/test-utils/env.js";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";
import { installTestEnv } from "./test-env.js";

const ORIGINAL_ENV = { ...process.env };

const tempDirs = new Set<string>();
const cleanupFns: Array<() => void> = [];

function restoreProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      deleteTestEnvValue(key);
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      deleteTestEnvValue(key);
    } else {
      setTestEnvValue(key, value);
    }
  }
}

function writeFile(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
}

function createTempHome(): string {
  return makeTempDir(tempDirs, "afora-test-env-real-home-");
}

function requireRecord(
  value: Record<string, unknown> | undefined,
  label: string,
): Record<string, unknown> {
  if (!value) {
    throw new Error(`expected copied ${label} config`);
  }
  return value;
}

function requireTelegramStreaming(
  value:
    | {
        mode?: string;
        chunkMode?: string;
        block?: { enabled?: boolean };
        preview?: { chunk?: { minChars?: number } };
      }
    | undefined,
) {
  if (!value) {
    throw new Error("expected copied telegram streaming config");
  }
  return value;
}

afterEach(() => {
  while (cleanupFns.length > 0) {
    cleanupFns.pop()?.();
  }
  restoreProcessEnv();
  cleanupTempDirs(tempDirs);
});

describe("installTestEnv", () => {
  it("keeps live tests on a temp HOME while copying config and auth state", () => {
    const realHome = createTempHome();
    const aforaHome = createTempHome();
    const priorIsolatedHome = createTempHome();
    writeFile(path.join(realHome, ".profile"), "export TEST_PROFILE_ONLY=from-profile\n");
    writeFile(
      path.join(aforaHome, "custom-afora.json5"),
      `{
        // Preserve provider config, strip host-bound paths.
        agents: {
          defaults: {
            workspace: "/Users/peter/Projects",
            agentDir: "/Users/peter/.afora/agents/main/agent",
          },
          list: [
            {
              id: "dev",
              workspace: "/Users/peter/dev-workspace",
              agentDir: "/Users/peter/.afora/agents/dev/agent",
            },
          ],
        },
        models: {
          providers: {
            custom: { baseUrl: "https://example.test/v1" },
          },
        },
        channels: {
          telegram: {
            streaming: {
              mode: "block",
              chunkMode: "newline",
              block: {
                enabled: true,
              },
              preview: {
                chunk: {
                  minChars: 120,
                },
              },
            },
          },
        },
      }`,
    );
    writeFile(path.join(aforaHome, ".afora", "credentials", "token.txt"), "secret\n");
    writeFile(
      path.join(aforaHome, ".afora", "external-plugins", "glueclaw", "afora.plugin.json"),
      '{"id":"glueclaw"}\n',
    );
    const realStateDir = path.join(aforaHome, ".afora");
    const realAgentDir = path.join(realStateDir, "agents", "main", "agent");
    const liveAuthStore = {
      version: 1,
      profiles: {
        "openai:api-key": {
          type: "api_key",
          provider: "openai",
          keyRef: {
            source: "env",
            provider: "default",
            id: "AFORA_LIVE_OPENAI_KEY",
          },
        },
      },
    };
    const liveAuthState = {
      version: 1,
      order: { openai: ["openai:api-key"] },
    };
    runAuthProfileWriteTransaction(
      realAgentDir,
      (database) => {
        writePersistedAuthProfileStoreRaw(liveAuthStore, realAgentDir, database);
        writePersistedAuthProfileStateRaw(liveAuthState, realAgentDir, database);
      },
      { stateDir: realStateDir },
    );
    cleanupFns.push(() => {
      closeAforaAgentDatabaseByPath(resolveAuthProfileDatabasePath(realAgentDir));
      closeAforaStateDatabaseByPath(
        resolveAforaStateSqlitePath({
          ...process.env,
          AFORA_STATE_DIR: realStateDir,
        }),
      );
    });
    writeFile(path.join(realHome, ".claude", ".credentials.json"), '{"accessToken":"token"}\n');
    writeFile(path.join(realHome, ".claude", "projects", "old-session.jsonl"), "session\n");
    fs.mkdirSync(path.join(realHome, ".claude", "settings.local.json"), { recursive: true });
    writeFile(path.join(realHome, ".codex", "auth.json"), '{"OPENAI_API_KEY":"token"}\n');
    writeFile(path.join(realHome, ".codex", "config.toml"), 'model = "gpt-5.4"\n');
    writeFile(
      path.join(realHome, ".codex", "sessions", "2026", "02", "26", "rollout.jsonl"),
      "session\n",
    );
    writeFile(path.join(realHome, ".gemini", "oauth_creds.json"), '{"token":"gemini"}\n');
    writeFile(path.join(realHome, ".gemini", "settings.json"), '{"theme":"dark"}\n');
    writeFile(path.join(realHome, ".gemini", "commands", "Cache", "review.toml"), "prompt\n");
    writeFile(path.join(realHome, ".minimax", "Cache", "credentials.json"), "minimax\n");
    writeFile(
      path.join(
        realHome,
        ".gemini",
        "antigravity-browser-profile",
        "Default",
        "Cache",
        "Cache_Data",
        "blob",
      ),
      "cached-browser-bytes\n",
    );
    writeFile(
      path.join(realHome, ".gemini", "antigravity", "browser_recordings", "session.webm"),
      "recording\n",
    );
    writeFile(
      path.join(realHome, ".gemini", "cli-browser-profile", "Default", "History"),
      "browser-history\n",
    );
    writeFile(path.join(realHome, ".gemini", "GPUCache", "data.bin"), "gpu-cache\n");
    writeFile(
      path.join(realHome, ".gemini", "Service Worker", "CacheStorage", "cache.bin"),
      "worker-cache\n",
    );

    setTestEnvValue("HOME", realHome);
    setTestEnvValue("USERPROFILE", realHome);
    setTestEnvValue("AFORA_HOME", aforaHome);
    setTestEnvValue("AFORA_LIVE_TEST", "1");
    setTestEnvValue("AFORA_LIVE_TEST_QUIET", "1");
    setTestEnvValue("AFORA_CONFIG_PATH", "~/custom-afora.json5");
    setTestEnvValue("AFORA_TEST_HOME", priorIsolatedHome);
    setTestEnvValue("AFORA_STATE_DIR", path.join(priorIsolatedHome, ".afora"));

    const testEnv = installTestEnv();
    cleanupFns.push(testEnv.cleanup);

    expect(testEnv.tempHome).not.toBe(realHome);
    expect(process.env.HOME).toBe(testEnv.tempHome);
    expect(process.env.AFORA_HOME).toBeUndefined();
    expect(process.env.AFORA_TEST_HOME).toBe(testEnv.tempHome);
    expect(process.env.TEST_PROFILE_ONLY).toBe("from-profile");

    const copiedConfigPath = path.join(testEnv.tempHome, ".afora", "afora.json");
    const copiedConfig = JSON.parse(fs.readFileSync(copiedConfigPath, "utf8")) as {
      agents?: {
        defaults?: Record<string, unknown>;
        list?: Array<Record<string, unknown>>;
      };
      models?: { providers?: Record<string, unknown> };
      channels?: {
        telegram?: {
          streaming?: {
            mode?: string;
            chunkMode?: string;
            block?: { enabled?: boolean };
            preview?: { chunk?: { minChars?: number } };
          };
        };
      };
    };
    const providers = requireRecord(copiedConfig.models?.providers, "model providers");
    expect(providers.custom).toEqual({ baseUrl: "https://example.test/v1" });

    const agentDefaults = requireRecord(copiedConfig.agents?.defaults, "agent defaults");
    const agentConfig = requireRecord(copiedConfig.agents?.list?.[0], "agent");
    expect(agentDefaults.workspace).toBeUndefined();
    expect(agentDefaults.agentDir).toBeUndefined();
    expect(agentConfig.workspace).toBeUndefined();
    expect(agentConfig.agentDir).toBeUndefined();

    const telegramStreaming = requireTelegramStreaming(copiedConfig.channels?.telegram?.streaming);
    expect(telegramStreaming).toEqual({
      mode: "block",
      chunkMode: "newline",
      block: { enabled: true },
      preview: { chunk: { minChars: 120 } },
    });

    expect(
      fs.existsSync(path.join(testEnv.tempHome, ".afora", "credentials", "token.txt")),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          testEnv.tempHome,
          ".afora",
          "external-plugins",
          "glueclaw",
          "afora.plugin.json",
        ),
      ),
    ).toBe(true);
    const stagedAgentDir = path.join(testEnv.tempHome, ".afora", "agents", "main", "agent");
    expect(inspectPersistedAuthProfileStoreRaw(stagedAgentDir)).toEqual({
      status: "readable",
      raw: liveAuthStore,
    });
    expect(inspectPersistedAuthProfileStateRaw(stagedAgentDir)).toEqual({
      status: "readable",
      raw: liveAuthState,
    });
    expect(fs.existsSync(path.join(stagedAgentDir, "auth-profiles.json"))).toBe(false);
    expect(fs.existsSync(path.join(testEnv.tempHome, ".claude", ".credentials.json"))).toBe(true);
    expect(fs.existsSync(path.join(testEnv.tempHome, ".claude", "projects"))).toBe(false);
    expect(fs.existsSync(path.join(testEnv.tempHome, ".claude", "settings.local.json"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(testEnv.tempHome, ".codex", "auth.json"))).toBe(true);
    expect(fs.existsSync(path.join(testEnv.tempHome, ".codex", "config.toml"))).toBe(true);
    expect(fs.existsSync(path.join(testEnv.tempHome, ".codex", "sessions"))).toBe(false);
    expect(fs.existsSync(path.join(testEnv.tempHome, ".gemini", "oauth_creds.json"))).toBe(true);
    expect(fs.existsSync(path.join(testEnv.tempHome, ".gemini", "settings.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(testEnv.tempHome, ".gemini", "commands", "Cache", "review.toml")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(testEnv.tempHome, ".minimax", "Cache", "credentials.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(testEnv.tempHome, ".gemini", "antigravity-browser-profile")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(testEnv.tempHome, ".gemini", "antigravity", "browser_recordings")),
    ).toBe(false);
    expect(fs.existsSync(path.join(testEnv.tempHome, ".gemini", "cli-browser-profile"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(testEnv.tempHome, ".gemini", "GPUCache"))).toBe(false);
    expect(
      fs.existsSync(path.join(testEnv.tempHome, ".gemini", "Service Worker", "CacheStorage")),
    ).toBe(false);
  });

  it("allows explicit live runs against the real HOME", () => {
    const realHome = createTempHome();
    writeFile(path.join(realHome, ".profile"), "export TEST_PROFILE_ONLY=from-profile\n");

    setTestEnvValue("HOME", realHome);
    setTestEnvValue("USERPROFILE", realHome);
    setTestEnvValue("AFORA_LIVE_TEST", "1");
    setTestEnvValue("AFORA_LIVE_USE_REAL_HOME", "1");
    setTestEnvValue("AFORA_LIVE_TEST_QUIET", "1");

    const testEnv = installTestEnv();

    expect(testEnv.tempHome).toBe(realHome);
    expect(process.env.HOME).toBe(realHome);
    expect(process.env.TEST_PROFILE_ONLY).toBe("from-profile");
  });

  it("keeps hermetic mode isolated when live flags request the real HOME", () => {
    const realHome = createTempHome();
    writeFile(path.join(realHome, ".profile"), "export TEST_PROFILE_ONLY=from-profile\n");
    writeFile(path.join(realHome, ".afora", "afora.json"), '{"live":true}\n');
    writeFile(path.join(realHome, ".afora", "credentials", "token.txt"), "secret\n");

    setTestEnvValue("HOME", realHome);
    setTestEnvValue("USERPROFILE", realHome);
    setTestEnvValue("LIVE", "1");
    setTestEnvValue("AFORA_LIVE_TEST", "1");
    setTestEnvValue("AFORA_LIVE_GATEWAY", "1");
    setTestEnvValue("AFORA_LIVE_USE_REAL_HOME", "1");
    const callerPluginDir = path.join(realHome, "caller-plugins");
    setTestEnvValue("AFORA_BUNDLED_PLUGINS_DIR", callerPluginDir);
    setTestEnvValue("AFORA_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    setTestEnvValue("AFORA_DISABLE_BUNDLED_PLUGINS", "1");
    setTestEnvValue("AFORA_HOME", realHome);

    const testEnv = installTestEnv({ mode: "hermetic" });
    cleanupFns.push(testEnv.cleanup);

    expect(testEnv.tempHome).not.toBe(realHome);
    expect(process.env.HOME).toBe(testEnv.tempHome);
    expect(process.env.TEST_PROFILE_ONLY).toBeUndefined();
    expect(process.env.LIVE).toBeUndefined();
    expect(process.env.AFORA_LIVE_TEST).toBeUndefined();
    expect(process.env.AFORA_LIVE_GATEWAY).toBeUndefined();
    expect(process.env.AFORA_LIVE_USE_REAL_HOME).toBeUndefined();
    expect(process.env.AFORA_BUNDLED_PLUGINS_DIR).not.toBe(callerPluginDir);
    expect(path.basename(process.env.AFORA_BUNDLED_PLUGINS_DIR ?? "")).toBe("extensions");
    expect(process.env.AFORA_TEST_TRUST_BUNDLED_PLUGINS_DIR).toBe("1");
    expect(process.env.AFORA_DISABLE_BUNDLED_PLUGINS).toBeUndefined();
    expect(process.env.AFORA_HOME).toBeUndefined();
    expect(fs.existsSync(path.join(testEnv.tempHome, ".afora", "afora.json"))).toBe(false);
    expect(
      fs.existsSync(path.join(testEnv.tempHome, ".afora", "credentials", "token.txt")),
    ).toBe(false);
  });

  it("clears and restores AFORA_HOME for normal isolated test runs", () => {
    const realHome = createTempHome();
    const configuredAforaHome = path.join(realHome, "custom-afora-home");
    setTestEnvValue("HOME", realHome);
    setTestEnvValue("USERPROFILE", realHome);
    setTestEnvValue("AFORA_HOME", configuredAforaHome);

    const testEnv = installTestEnv();

    expect(testEnv.tempHome).not.toBe(realHome);
    expect(process.env.AFORA_HOME).toBeUndefined();

    testEnv.cleanup();
    expect(process.env.AFORA_HOME).toBe(configuredAforaHome);
  });

  it("does not load ~/.profile for normal isolated test runs", () => {
    const realHome = createTempHome();
    writeFile(path.join(realHome, ".profile"), "export TEST_PROFILE_ONLY=from-profile\n");

    setTestEnvValue("HOME", realHome);
    setTestEnvValue("USERPROFILE", realHome);
    deleteTestEnvValue("LIVE");
    deleteTestEnvValue("AFORA_LIVE_TEST");
    deleteTestEnvValue("AFORA_LIVE_GATEWAY");
    deleteTestEnvValue("AFORA_LIVE_USE_REAL_HOME");
    deleteTestEnvValue("AFORA_LIVE_TEST_QUIET");

    const testEnv = installTestEnv();
    cleanupFns.push(testEnv.cleanup);

    expect(testEnv.tempHome).not.toBe(realHome);
    expect(process.env.TEST_PROFILE_ONLY).toBeUndefined();
  });

  it("falls back to parsing ~/.profile when bash is unavailable", async () => {
    const realHome = createTempHome();
    writeFile(path.join(realHome, ".profile"), "export TEST_PROFILE_ONLY=from-profile\n");

    setTestEnvValue("HOME", realHome);
    setTestEnvValue("USERPROFILE", realHome);
    setTestEnvValue("AFORA_LIVE_TEST", "1");
    setTestEnvValue("AFORA_LIVE_USE_REAL_HOME", "1");
    setTestEnvValue("AFORA_LIVE_TEST_QUIET", "1");

    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw Object.assign(new Error("bash missing"), { code: "ENOENT" });
      },
    }));

    const { installTestEnv: installFreshTestEnv } = await importFreshModule<
      typeof import("./test-env.js")
    >(import.meta.url, "./test-env.js?scope=profile-fallback");

    const testEnv = installFreshTestEnv();

    expect(testEnv.tempHome).toBe(realHome);
    expect(process.env.TEST_PROFILE_ONLY).toBe("from-profile");
  });
});
