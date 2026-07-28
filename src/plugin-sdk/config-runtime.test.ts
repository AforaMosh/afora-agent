/**
 * Tests config runtime exports and snapshot/cache behavior exposed through the SDK.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  getSessionEntry,
  listSessionEntries,
  readSessionUpdatedAt,
  resolveLivePluginConfigObject,
  resolvePluginConfigObject,
  writeConfigFile,
  type OpenClawConfig,
} from "./config-runtime.js";
import {
  getSessionEntry as getSessionStoreEntry,
  listSessionEntries as listSessionStoreEntries,
  readSessionUpdatedAt as readSessionStoreUpdatedAt,
} from "./session-store-runtime.js";

describe("deprecated config-runtime writeConfigFile", () => {
  it("preserves authored env refs, includes, and untouched fields through write intent", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(path.join(stateDir, "channels.json"), "{}\n", "utf8");
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            $schema: "https://openclaw.ai/config.schema.json",
            agents: {
              entries: { main: { default: true }, ops: {} },
            },
            channels: { $include: "./channels.json" },
            gateway: { mode: "local" },
            logging: { level: "info" },
            messages: { queue: { mode: "collect" } },
            models: {
              providers: {
                custom: {
                  apiKey: "${HOME}",
                  baseUrl: "https://example.invalid/v1",
                  models: [],
                },
              },
            },
            plugins: {
              entries: {
                demo: {
                  enabled: true,
                  config: { args: ["literal", "${HOME}"], items: [{ id: "one" }] },
                },
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      const { readConfigFileSnapshotForWrite } = await import("../config/io.js");
      const { snapshot } = await readConfigFileSnapshotForWrite({
        skipPluginValidation: true,
      });
      expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
      const candidate = structuredClone(snapshot.runtimeConfig);
      candidate.gateway = { ...candidate.gateway, port: 19001 };
      candidate.messages = {
        ...candidate.messages,
        queue: { ...candidate.messages?.queue, mode: "followup" },
      };
      await writeConfigFile(candidate, {
        explicitSetPaths: [
          ["messages"],
          ["models", "providers", "custom", "apiKey"],
          ["plugins", "entries", "demo", "config", "empty"],
        ],
        explicitSetValueSource: {
          messages: { ackReaction: "eyes" },
          models: {
            providers: {
              custom: {
                apiKey: "explicit-value",
                baseUrl: "https://example.invalid/v1",
                models: [],
              },
            },
          },
          plugins: { entries: { demo: { config: { empty: {} } } } },
        },
        unsetPaths: [["logging", "level"]],
        skipPluginValidation: true,
        skipRuntimeSnapshotRefresh: true,
      });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<
        string,
        unknown
      >;
      expect(persisted).toMatchObject({
        $schema: "https://openclaw.ai/config.schema.json",
        agents: { entries: { main: { default: true }, ops: {} } },
        channels: { $include: "./channels.json" },
        gateway: { mode: "local", port: 19001 },
        messages: { ackReaction: "eyes", queue: { mode: "followup" } },
        models: {
          providers: {
            custom: {
              apiKey: "explicit-value",
              baseUrl: "https://example.invalid/v1",
              models: [],
            },
          },
        },
        plugins: {
          entries: {
            demo: {
              enabled: true,
              config: { args: ["literal", "${HOME}"], empty: {}, items: [{ id: "one" }] },
            },
          },
        },
      });
      expect(persisted).not.toHaveProperty("logging");
    });
  });

  it("persists a legacy explicit-set literal equal to the resolved authored value", async () => {
    await withTempHome(async (home) => {
      await withEnvAsync({ OPENCLAW_EXPLICIT_PREFIX: "resolved-prefix" }, async () => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          configPath,
          JSON.stringify({ messages: { responsePrefix: "${OPENCLAW_EXPLICIT_PREFIX}" } }),
          "utf8",
        );
        const { readConfigFileSnapshotForWrite } = await import("../config/io.js");
        const { snapshot } = await readConfigFileSnapshotForWrite({
          skipPluginValidation: true,
        });

        await writeConfigFile(snapshot.runtimeConfig, {
          explicitSetPaths: [["messages", "responsePrefix"]],
          skipPluginValidation: true,
          skipRuntimeSnapshotRefresh: true,
        });

        const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
        expect(persisted.messages?.responsePrefix).toBe("resolved-prefix");
      });
    });
  });

  it("accepts an unchanged runtime candidate when the source has includes", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(path.join(stateDir, "channels.json"), "{}\n", "utf8");
      await fs.writeFile(
        configPath,
        JSON.stringify({
          channels: { $include: "./channels.json" },
          gateway: { mode: "local" },
        }),
        "utf8",
      );
      const { readConfigFileSnapshotForWrite } = await import("../config/io.js");
      const { snapshot } = await readConfigFileSnapshotForWrite({
        skipPluginValidation: true,
      });

      await writeConfigFile(snapshot.runtimeConfig, {
        skipPluginValidation: true,
        skipRuntimeSnapshotRefresh: true,
      });

      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
        channels: { $include: "./channels.json" },
        gateway: { mode: "local" },
      });
    });
  });

  it("preserves implicit main when a compatibility candidate first authors the roster", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ gateway: { mode: "local" } }), "utf8");
      const { readConfigFileSnapshotForWrite } = await import("../config/io.js");
      const { snapshot } = await readConfigFileSnapshotForWrite({ skipPluginValidation: true });
      const candidate = structuredClone(snapshot.runtimeConfig);
      candidate.agents = { ...candidate.agents, entries: { ops: { default: true } } };

      await writeConfigFile(candidate, {
        skipPluginValidation: true,
        skipRuntimeSnapshotRefresh: true,
      });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      expect(persisted.agents?.entries).toEqual({ main: {}, ops: { default: true } });
    });
  });

  it("persists explicit null values from a complete compatibility candidate", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ plugins: { entries: { demo: { config: { mode: "auto" } } } } }),
        "utf8",
      );
      const { readConfigFileSnapshotForWrite } = await import("../config/io.js");
      const { snapshot } = await readConfigFileSnapshotForWrite({ skipPluginValidation: true });
      const candidate = structuredClone(snapshot.runtimeConfig);

      await writeConfigFile(candidate, {
        explicitSetPaths: [["plugins", "entries", "demo", "config"]],
        explicitSetValueSource: {
          plugins: { entries: { demo: { config: { mode: null } } } },
        },
        skipPluginValidation: true,
        skipRuntimeSnapshotRefresh: true,
      });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      expect(persisted.plugins?.entries?.demo?.config).toMatchObject({ mode: null });
    });
  });

  it("preserves unchanged authored refs beneath a runtime-shaped explicit parent set", async () => {
    await withTempHome(async (home) => {
      await withEnvAsync({ PLUGIN_TOKEN: "resolved-token" }, async () => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          configPath,
          JSON.stringify({
            plugins: {
              entries: {
                demo: { config: { token: "${PLUGIN_TOKEN}", mode: "old" } },
              },
            },
          }),
          "utf8",
        );
        const { readConfigFileSnapshotForWrite } = await import("../config/io.js");
        const { snapshot } = await readConfigFileSnapshotForWrite({ skipPluginValidation: true });
        const candidate = structuredClone(snapshot.runtimeConfig);
        const config = candidate.plugins?.entries?.demo?.config as Record<string, unknown>;
        config.mode = "new";

        await writeConfigFile(candidate, {
          explicitSetPaths: [["plugins", "entries", "demo", "config"]],
          skipPluginValidation: true,
          skipRuntimeSnapshotRefresh: true,
        });

        const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
        expect(persisted.plugins?.entries?.demo?.config).toEqual({
          token: "${PLUGIN_TOKEN}",
          mode: "new",
        });
      });
    });
  });

  it("rejects changed arrays whose authored references were runtime-resolved", async () => {
    await withTempHome(async (home) => {
      await withEnvAsync({ TOKEN: "resolved-token" }, async () => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          configPath,
          JSON.stringify({ plugins: { allow: ["${TOKEN}", "old"] } }),
          "utf8",
        );
        const { readConfigFileSnapshotForWrite } = await import("../config/io.js");
        const { snapshot } = await readConfigFileSnapshotForWrite({ skipPluginValidation: true });
        const candidate = structuredClone(snapshot.runtimeConfig);
        candidate.plugins = { ...candidate.plugins, allow: ["resolved-token", "new"] };

        await expect(
          writeConfigFile(candidate, {
            skipPluginValidation: true,
            skipRuntimeSnapshotRefresh: true,
          }),
        ).rejects.toThrow("cannot safely replace runtime-resolved array at plugins.allow");
      });
    });
  });

  it("does not infer deletion of a value supplied only by an ancestor include", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "base.json"),
        JSON.stringify({ gateway: { auth: { mode: "none" } } }),
        "utf8",
      );
      await fs.writeFile(
        configPath,
        JSON.stringify({
          $include: "./base.json",
          gateway: { mode: "local" },
        }),
        "utf8",
      );
      const { readConfigFileSnapshotForWrite } = await import("../config/io.js");
      const { snapshot } = await readConfigFileSnapshotForWrite({
        skipPluginValidation: true,
      });
      const candidate = structuredClone(snapshot.runtimeConfig);
      delete candidate.gateway?.auth;

      await writeConfigFile(candidate, {
        skipPluginValidation: true,
        skipRuntimeSnapshotRefresh: true,
      });
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
        $include: "./base.json",
        gateway: { mode: "local" },
      });
    });
  });

  it("does not create an empty source container when deleting below a root include", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "base.json"),
        JSON.stringify({ gateway: { auth: { mode: "none" } } }),
        "utf8",
      );
      await fs.writeFile(configPath, JSON.stringify({ $include: "./base.json" }), "utf8");
      const { readConfigFileSnapshotForWrite } = await import("../config/io.js");
      const { snapshot } = await readConfigFileSnapshotForWrite({ skipPluginValidation: true });
      const candidate = structuredClone(snapshot.runtimeConfig);
      delete candidate.gateway?.auth;

      await writeConfigFile(candidate, {
        skipPluginValidation: true,
        skipRuntimeSnapshotRefresh: true,
      });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<
        string,
        unknown
      >;
      expect(persisted).toMatchObject({ $include: "./base.json" });
      expect(persisted).not.toHaveProperty("gateway");
    });
  });

  it("rejects an explicit unset of an include-only value", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "base.json"),
        JSON.stringify({ gateway: { auth: { mode: "none" } } }),
        "utf8",
      );
      await fs.writeFile(
        configPath,
        JSON.stringify({ $include: "./base.json", gateway: { mode: "local" } }),
        "utf8",
      );
      const { readConfigFileSnapshotForWrite } = await import("../config/io.js");
      const { snapshot } = await readConfigFileSnapshotForWrite({ skipPluginValidation: true });

      await expect(
        writeConfigFile(snapshot.runtimeConfig, {
          unsetPaths: [["gateway", "auth"]],
          skipPluginValidation: true,
          skipRuntimeSnapshotRefresh: true,
        }),
      ).rejects.toThrow("Config write cannot update $include-owned config at <root>");
    });
  });

  it("treats an empty unset path as a no-op", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "base.json"),
        JSON.stringify({ gateway: { auth: { mode: "none" } } }),
        "utf8",
      );
      await fs.writeFile(
        configPath,
        JSON.stringify({ $include: "./base.json", gateway: { mode: "local" } }),
        "utf8",
      );
      const { readConfigFileSnapshotForWrite } = await import("../config/io.js");
      const { snapshot } = await readConfigFileSnapshotForWrite({ skipPluginValidation: true });
      const candidate = structuredClone(snapshot.runtimeConfig);
      delete candidate.gateway?.auth;

      await writeConfigFile(candidate, {
        unsetPaths: [[]],
        skipPluginValidation: true,
        skipRuntimeSnapshotRefresh: true,
      });
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
        $include: "./base.json",
        gateway: { mode: "local" },
      });
    });
  });

  it("rejects an explicit unset beside a root include", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "base.json"),
        JSON.stringify({ gateway: { auth: { mode: "none" } } }),
        "utf8",
      );
      await fs.writeFile(
        configPath,
        JSON.stringify({
          $include: "./base.json",
          gateway: { mode: "local", auth: { mode: "token", token: "local-token" } },
        }),
        "utf8",
      );
      const { readConfigFileSnapshotForWrite } = await import("../config/io.js");
      const { snapshot } = await readConfigFileSnapshotForWrite({ skipPluginValidation: true });
      const candidate = structuredClone(snapshot.runtimeConfig);
      delete candidate.gateway?.auth;

      await expect(
        writeConfigFile(candidate, {
          unsetPaths: [["gateway", "auth"]],
          skipPluginValidation: true,
          skipRuntimeSnapshotRefresh: true,
        }),
      ).rejects.toThrow("Config write cannot update $include-owned config at <root>");
    });
  });

  it("rejects an explicit object set below a root include", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "base.json"),
        JSON.stringify({ gateway: { auth: { mode: "token", token: "test-token" } } }),
        "utf8",
      );
      await fs.writeFile(
        configPath,
        JSON.stringify({ $include: "./base.json", gateway: { mode: "local" } }),
        "utf8",
      );
      const { readConfigFileSnapshotForWrite } = await import("../config/io.js");
      const { snapshot } = await readConfigFileSnapshotForWrite({ skipPluginValidation: true });
      const candidate = structuredClone(snapshot.runtimeConfig);
      candidate.gateway = {
        ...candidate.gateway,
        auth: { ...candidate.gateway?.auth, mode: "none" },
      };

      await expect(
        writeConfigFile(candidate, {
          explicitSetPaths: [["gateway", "auth"]],
          explicitSetValueSource: { gateway: { auth: { mode: "none" } } },
          skipPluginValidation: true,
          skipRuntimeSnapshotRefresh: true,
        }),
      ).rejects.toThrow("Config write cannot update $include-owned config at <root>");
    });
  });

  it("rejects an explicit null override below a root include", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "base.json"),
        JSON.stringify({ plugins: { entries: { demo: { config: { mode: "auto" } } } } }),
        "utf8",
      );
      await fs.writeFile(configPath, JSON.stringify({ $include: "./base.json" }), "utf8");
      const { readConfigFileSnapshotForWrite } = await import("../config/io.js");
      const { snapshot } = await readConfigFileSnapshotForWrite({ skipPluginValidation: true });
      const candidate = structuredClone(snapshot.runtimeConfig);
      const demoConfig = candidate.plugins?.entries?.demo?.config as
        | Record<string, unknown>
        | undefined;
      if (!demoConfig) {
        throw new Error("expected demo plugin config");
      }
      demoConfig.mode = null;

      await expect(
        writeConfigFile(candidate, {
          skipPluginValidation: true,
          skipRuntimeSnapshotRefresh: true,
        }),
      ).rejects.toThrow("Config write cannot update $include-owned config at <root>");
    });
  });
});

describe("config-runtime session read exports", () => {
  it("re-exports the session-store runtime seam wrappers", () => {
    expect(getSessionEntry).toBe(getSessionStoreEntry);
    expect(listSessionEntries).toBe(listSessionStoreEntries);
    expect(readSessionUpdatedAt).toBe(readSessionStoreUpdatedAt);
  });
});

describe("resolvePluginConfigObject", () => {
  it("returns the plugin config object for a configured plugin entry", () => {
    const config = {
      plugins: {
        entries: {
          "demo-plugin": {
            enabled: true,
            config: {
              enabled: false,
              mode: "strict",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolvePluginConfigObject(config, "demo-plugin")).toEqual({
      enabled: false,
      mode: "strict",
    });
  });

  it("reads config through normalized plugin entry ids", () => {
    const config = {
      plugins: {
        entries: {
          " CODEX ": {
            enabled: true,
            config: { supervision: { enabled: true } },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolvePluginConfigObject(config, "codex")).toEqual({
      supervision: { enabled: true },
    });
  });

  it("returns undefined for missing or non-object plugin configs", () => {
    const config = {
      plugins: {
        entries: {
          "demo-plugin": {
            enabled: true,
            config: "bad-shape",
          },
          "array-plugin": {
            enabled: true,
            config: ["bad-shape"],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolvePluginConfigObject(config, "missing-plugin")).toBeUndefined();
    expect(resolvePluginConfigObject(config, "demo-plugin")).toBeUndefined();
    expect(resolvePluginConfigObject(config, "array-plugin")).toBeUndefined();
    expect(resolvePluginConfigObject(undefined, "demo-plugin")).toBeUndefined();
  });
});

describe("resolveLivePluginConfigObject", () => {
  it("falls back to startup config only when no runtime loader exists", () => {
    expect(
      resolveLivePluginConfigObject(undefined, "demo-plugin", {
        enabled: true,
      }),
    ).toEqual({
      enabled: true,
    });
  });

  it("fails closed when the runtime loader exists but the plugin entry is missing", () => {
    const config = {
      plugins: {
        entries: {},
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveLivePluginConfigObject(() => config, "demo-plugin", {
        enabled: true,
      }),
    ).toBeUndefined();
  });
});
