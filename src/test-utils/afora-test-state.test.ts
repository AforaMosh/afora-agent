// Tests isolated Afora test-state setup and cleanup behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import {
  closeAuthProfileReadPool,
  resolveAuthProfileDatabasePath,
} from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import {
  GATEWAY_STARTUP_MUTATED_ENV_KEYS,
  snapshotGatewayStartupEnv,
} from "../gateway/test-helpers.env.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import {
  closeAforaAgentDatabaseByPath,
  openAforaAgentDatabase,
} from "../state/afora-agent-db.js";
import {
  closeAforaStateDatabaseByPath,
  openAforaStateDatabase,
} from "../state/afora-state-db.js";
import { setTestEnvValue, withEnvAsync } from "./env.js";
import { createAforaTestState, withAforaTestState } from "./afora-test-state.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected missing path: ${targetPath}`);
}

describe("afora test state", () => {
  it("creates an isolated home layout with spawn env and restores process env", async () => {
    const previousHome = process.env.HOME;
    const previousAforaHome = process.env.AFORA_HOME;
    const previousStateDir = process.env.AFORA_STATE_DIR;
    const previousConfigPath = process.env.AFORA_CONFIG_PATH;
    const previousGatewayStartupEnv = snapshotGatewayStartupEnv();

    const state = await createAforaTestState({
      label: "unit",
      scenario: "minimal",
    });

    try {
      expect(state.home).toBe(path.join(state.root, "home"));
      expect(state.stateDir).toBe(path.join(state.home, ".afora"));
      expect(state.configPath).toBe(path.join(state.stateDir, "afora.json"));
      expect(state.workspaceDir).toBe(path.join(state.home, "workspace"));
      expect(state.env.HOME).toBe(state.home);
      expect(state.env.AFORA_HOME).toBe(state.home);
      expect(state.env.AFORA_STATE_DIR).toBe(state.stateDir);
      expect(state.env.AFORA_CONFIG_PATH).toBe(state.configPath);
      expect(process.env.HOME).toBe(state.home);
      expect(process.env.AFORA_HOME).toBe(state.home);
      expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toStrictEqual({});
      for (const key of GATEWAY_STARTUP_MUTATED_ENV_KEYS) {
        setTestEnvValue(key, `mutated-${key}`);
      }
    } finally {
      await state.cleanup();
    }

    expect(process.env.HOME).toBe(previousHome);
    expect(process.env.AFORA_HOME).toBe(previousAforaHome);
    expect(process.env.AFORA_STATE_DIR).toBe(previousStateDir);
    expect(process.env.AFORA_CONFIG_PATH).toBe(previousConfigPath);
    expect(snapshotGatewayStartupEnv()).toEqual(previousGatewayStartupEnv);
    await expectPathMissing(state.root);
  });

  it("supports state-only layout without overriding HOME", async () => {
    const previousHome = process.env.HOME;

    await withAforaTestState(
      {
        layout: "state-only",
        scenario: "empty",
      },
      async (state) => {
        expect(process.env.HOME).toBe(previousHome);
        expect(process.env.AFORA_STATE_DIR).toBe(state.stateDir);
        expect(process.env.AFORA_CONFIG_PATH).toBe(state.configPath);
        expect(state.env.HOME).toBe(previousHome);
        await expectPathMissing(state.configPath);
      },
    );
  });

  it("clears inherited agent-dir overrides by default", async () => {
    await withEnvAsync({ AFORA_AGENT_DIR: "/tmp/outside-afora-agent" }, async () => {
      const state = await createAforaTestState({
        layout: "state-only",
      });

      try {
        expect(process.env.AFORA_AGENT_DIR).toBeUndefined();
        expect(state.env.AFORA_AGENT_DIR).toBeUndefined();
        expect(state.agentDir()).toBe(path.join(state.stateDir, "agents", "main", "agent"));
      } finally {
        await state.cleanup();
      }

      expect(process.env.AFORA_AGENT_DIR).toBe("/tmp/outside-afora-agent");
    });
  });

  it("allows explicit agent-dir overrides when a test needs them", async () => {
    await withAforaTestState(
      {
        env: {
          AFORA_AGENT_DIR: "/tmp/explicit-afora-agent",
        },
      },
      async (state) => {
        expect(process.env.AFORA_AGENT_DIR).toBe("/tmp/explicit-afora-agent");
        expect(state.env.AFORA_AGENT_DIR).toBe("/tmp/explicit-afora-agent");
      },
    );
  });

  it("can route agent-dir env vars to the isolated main agent store", async () => {
    await withAforaTestState(
      {
        agentEnv: "main",
      },
      async (state) => {
        expect(process.env.AFORA_AGENT_DIR).toBe(state.agentDir());
        expect(state.env.AFORA_AGENT_DIR).toBe(state.agentDir());
      },
    );
  });

  it("writes scenario configs and auth profile stores", async () => {
    await withAforaTestState(
      {
        scenario: "update-stable",
      },
      async (state) => {
        expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual({
          update: {
            channel: "stable",
          },
          plugins: {},
        });

        const profilePath = await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "openai:test": {
              type: "api_key",
              provider: "openai",
              key: "sk-test",
            },
          },
        });

        expect(profilePath).toBe(path.join(state.agentDir(), "afora-agent.sqlite"));
        const profiles = loadPersistedAuthProfileStore(state.agentDir());
        expect(profiles?.version).toBe(1);
        expect(profiles?.profiles["openai:test"]?.provider).toBe("openai");
      },
    );
  });

  it("closes only fixture-owned databases before restoring env", async () => {
    const previousStateDir = process.env.AFORA_STATE_DIR;
    const unrelatedRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "afora-test-state-unrelated-"),
    );
    const unrelatedEnv = {
      ...process.env,
      AFORA_STATE_DIR: path.join(unrelatedRoot, "state"),
    };
    const state = await createAforaTestState({
      layout: "state-only",
      label: "database-cleanup",
    });
    const authStore = {
      version: 1,
      profiles: {
        "openai:test": {
          type: "api_key" as const,
          provider: "openai",
          key: "sk-test",
        },
      },
    };
    const fixtureAuthDir = state.agentDir("auth-reader");
    const fixtureAuthPath = resolveAuthProfileDatabasePath(fixtureAuthDir);
    saveAuthProfileStore(authStore, fixtureAuthDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    const unrelatedAgentDir = path.join(unrelatedRoot, "state", "agents", "outside", "agent");
    saveAuthProfileStore(authStore, unrelatedAgentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    const fixtureShared = openAforaStateDatabase({ env: state.env });
    const fixtureAgent = openAforaAgentDatabase({
      agentId: "worker",
      env: state.env,
    });
    const unrelatedShared = openAforaStateDatabase({ env: unrelatedEnv });
    const unrelatedAgent = openAforaAgentDatabase({
      agentId: "outside",
      env: unrelatedEnv,
    });
    const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    expect(loadPersistedAuthProfileStore(state.agentDir("auth-reader"))).not.toBeNull();
    expect(loadPersistedAuthProfileStore(unrelatedAgentDir)).not.toBeNull();
    const readOnlyDatabases = openSpy.mock.calls.flatMap((call, index) => {
      if (call[1]?.readOnly !== true) {
        return [];
      }
      const database = openSpy.mock.results[index]?.value as DatabaseSync | undefined;
      return database ? [{ path: path.resolve(call[0]), database }] : [];
    });
    const fixtureAuthReader = readOnlyDatabases.find(
      (entry) => entry.path === path.resolve(fixtureAuthPath),
    )?.database;
    const unrelatedAuthReader = readOnlyDatabases.find(
      (entry) => entry.path === path.resolve(unrelatedAgent.path),
    )?.database;
    if (!fixtureAuthReader || !unrelatedAuthReader) {
      throw new Error("expected fixture and unrelated pooled auth readers");
    }
    expect(fixtureAuthReader.isOpen).toBe(true);
    expect(unrelatedAuthReader.isOpen).toBe(true);
    const restoreEnv = state.restoreEnv;
    const originalRm = fs.rm;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation((...args) => {
      expect(fixtureAuthReader.isOpen).toBe(false);
      expect(unrelatedAuthReader.isOpen).toBe(true);
      return originalRm(...args);
    });
    state.restoreEnv = () => {
      expect(process.env.AFORA_STATE_DIR).toBe(state.stateDir);
      expect(fixtureAuthReader.isOpen).toBe(false);
      expect(fixtureShared.db.isOpen).toBe(false);
      expect(fixtureAgent.db.isOpen).toBe(false);
      expect(unrelatedAuthReader.isOpen).toBe(true);
      expect(unrelatedShared.db.isOpen).toBe(true);
      expect(unrelatedAgent.db.isOpen).toBe(true);
      restoreEnv();
    };

    try {
      await state.cleanup();

      expect(process.env.AFORA_STATE_DIR).toBe(previousStateDir);
      expect(rmSpy).toHaveBeenCalledWith(state.root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25,
      });
      await expectPathMissing(state.root);
      expect(unrelatedAuthReader.isOpen).toBe(true);
      expect(unrelatedShared.db.isOpen).toBe(true);
      expect(unrelatedAgent.db.isOpen).toBe(true);
    } finally {
      state.restoreEnv = restoreEnv;
      restoreEnv();
      closeAuthProfileReadPool({ kind: "database", databasePath: fixtureAuthPath });
      closeAuthProfileReadPool({ kind: "database", databasePath: unrelatedAgent.path });
      closeAforaAgentDatabaseByPath(fixtureAgent.path);
      closeAforaAgentDatabaseByPath(unrelatedAgent.path);
      closeAforaStateDatabaseByPath(fixtureShared.path);
      closeAforaStateDatabaseByPath(unrelatedShared.path);
      openSpy.mockRestore();
      rmSpy.mockRestore();
      await fs.rm(state.root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25,
      });
      await fs.rm(unrelatedRoot, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25,
      });
    }
  });

  it("preserves callback failures after closing fixture databases", async () => {
    const callbackError = new Error("fixture callback failed");
    let root = "";
    let shared: ReturnType<typeof openAforaStateDatabase> | undefined;
    let agent: ReturnType<typeof openAforaAgentDatabase> | undefined;

    await expect(
      withAforaTestState({ layout: "state-only", label: "callback-failure" }, async (state) => {
        root = state.root;
        shared = openAforaStateDatabase({ env: state.env });
        agent = openAforaAgentDatabase({
          agentId: "main",
          env: state.env,
        });
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);

    expect(shared?.db.isOpen).toBe(false);
    expect(agent?.db.isOpen).toBe(false);
    await expectPathMissing(root);
  });

  it("creates upgrade survivor fixture state", async () => {
    await withAforaTestState(
      {
        scenario: "upgrade-survivor",
      },
      async (state) => {
        const config = JSON.parse(await fs.readFile(state.configPath, "utf8"));
        expect(config.update?.channel).toBe("stable");
        expect(config.plugins?.enabled).toBe(true);
        expect(config.plugins?.allow).toStrictEqual(["discord", "telegram", "whatsapp", "memory"]);
      },
    );
  });

  it("keeps external-service env scoped to the fixture", async () => {
    const previousPolicy = process.env.AFORA_SERVICE_REPAIR_POLICY;

    await withAforaTestState(
      {
        scenario: "external-service",
      },
      async (state) => {
        expect(process.env.AFORA_SERVICE_REPAIR_POLICY).toBe("external");
        expect(state.env.AFORA_SERVICE_REPAIR_POLICY).toBe("external");
      },
    );

    expect(process.env.AFORA_SERVICE_REPAIR_POLICY).toBe(previousPolicy);
  });
});
