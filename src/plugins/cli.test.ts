/** CLI integration coverage for plugin commands, setup, status, and registry flows. */
import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AforaConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  memoryRegister: vi.fn(),
  otherRegister: vi.fn(),
  memoryListAction: vi.fn(),
  loadAforaPluginCliRegistry: vi.fn(),
  loadAforaPlugins: vi.fn(),
  resolveManifestActivationPluginIds: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
  loadConfig: vi.fn(),
  getRuntimeConfigSnapshot: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("./loader.js", () => ({
  loadAforaPluginCliRegistry: (...args: unknown[]) =>
    mocks.loadAforaPluginCliRegistry(...args),
  loadAforaPlugins: (...args: unknown[]) => mocks.loadAforaPlugins(...args),
  loadPluginRegistryHandle: (options: Record<string, unknown> = {}) =>
    mocks.loadAforaPlugins({ ...options, activate: false }),
}));

vi.mock("./activation-planner.js", () => ({
  resolveManifestActivationPluginIds: (...args: unknown[]) =>
    mocks.resolveManifestActivationPluginIds(...args),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => mocks.applyPluginAutoEnable(...args),
}));

vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: () => ({ plugins: [], diagnostics: [] }),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  isPluginMetadataSnapshotCompatible: () => true,
  rebasePluginMetadataSnapshotManifestRegistry: <T>(snapshot: T) => snapshot,
  resolvePluginMetadataSnapshot: (...args: unknown[]) =>
    mocks.resolvePluginMetadataSnapshot(...args),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: (...args: unknown[]) => mocks.loadConfig(...args),
  getRuntimeConfigSnapshot: (...args: unknown[]) => mocks.getRuntimeConfigSnapshot(...args),
  loadConfig: (...args: unknown[]) => mocks.loadConfig(...args),
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
}));

let getPluginCliCommandDescriptors: typeof import("./cli.js").getPluginCliCommandDescriptors;
let loadValidatedConfigForPluginRegistration: typeof import("./cli.js").loadValidatedConfigForPluginRegistration;
let registerPluginCliCommands: typeof import("./cli.js").registerPluginCliCommands;
let registerPluginCliCommandsFromValidatedConfig: typeof import("./cli.js").registerPluginCliCommandsFromValidatedConfig;

function createProgram(existingCommandName?: string) {
  const program = new Command();
  if (existingCommandName) {
    program.command(existingCommandName);
  }
  return program;
}

function createCliRegistry(params?: {
  memoryCommands?: string[];
  memoryDescriptors?: Array<{
    name: string;
    description: string;
    hasSubcommands: boolean;
  }>;
  memoryParentPath?: string[];
}) {
  return {
    cliRegistrars: [
      {
        pluginId: "memory-core",
        register: mocks.memoryRegister,
        parentPath: params?.memoryParentPath ?? [],
        commands: params?.memoryCommands ?? ["memory"],
        descriptors: params?.memoryDescriptors ?? [
          {
            name: "memory",
            description: "Memory commands",
            hasSubcommands: true,
          },
        ],
        source: "bundled",
      },
      {
        pluginId: "other",
        register: mocks.otherRegister,
        parentPath: [],
        commands: ["other"],
        descriptors: [],
        source: "bundled",
      },
    ],
  };
}

function createAutoEnabledCliFixture() {
  const rawConfig = {
    plugins: {},
    channels: { demo: { enabled: true } },
  } as AforaConfig;
  const autoEnabledConfig = {
    ...rawConfig,
    plugins: {
      entries: {
        demo: { enabled: true },
      },
    },
  } as AforaConfig;
  return { rawConfig, autoEnabledConfig };
}

function createCliMetadataSnapshot() {
  const plugin = {
    id: "matrix",
    origin: "bundled",
    format: "afora",
    cliCommands: [
      {
        name: "matrix",
        description: "Matrix channel utilities",
        hasSubcommands: true,
      },
    ],
  };
  return {
    policyHash: "test",
    index: {
      installRecords: {},
      plugins: [{ pluginId: "matrix", enabled: true, enabledByDefault: true, origin: "bundled" }],
    },
    manifestRegistry: { plugins: [plugin], diagnostics: [] },
    plugins: [plugin],
    diagnostics: [],
    byPluginId: new Map([[plugin.id, plugin]]),
    owners: {},
  };
}

function createLegacyExternalCliMetadataSnapshot() {
  const plugin = {
    id: "legacy-cli",
    origin: "config",
    format: "afora",
  };
  return {
    policyHash: "test",
    index: {
      installRecords: {},
      plugins: [{ pluginId: plugin.id, enabled: true, origin: plugin.origin }],
    },
    manifestRegistry: { plugins: [plugin], diagnostics: [] },
    plugins: [plugin],
    diagnostics: [],
    byPluginId: new Map([[plugin.id, plugin]]),
    owners: {},
  };
}

function getMockCallObject(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const value = mock.mock.calls[callIndex]?.[argIndex];
  if (!value || typeof value !== "object") {
    throw new Error(`expected mock call ${callIndex} arg ${argIndex} object`);
  }
  return value as Record<string, unknown>;
}

function expectAutoEnabledCliLoad(params: {
  rawConfig: AforaConfig;
  autoEnabledConfig: AforaConfig;
  autoEnabledReasons?: Record<string, string[]>;
}) {
  expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith(
    expect.objectContaining({
      config: params.rawConfig,
      env: process.env,
    }),
  );
  const loadOptions = getMockCallObject(mocks.loadAforaPlugins);
  expect(loadOptions.config).toBe(params.autoEnabledConfig);
  expect(loadOptions.activationSourceConfig).toBe(params.rawConfig);
  expect(loadOptions.autoEnabledReasons).toEqual(params.autoEnabledReasons ?? {});
}

describe("registerPluginCliCommands", () => {
  beforeAll(async () => {
    ({
      getPluginCliCommandDescriptors,
      loadValidatedConfigForPluginRegistration,
      registerPluginCliCommands,
      registerPluginCliCommandsFromValidatedConfig,
    } = await import("./cli.js"));
  });

  beforeEach(() => {
    mocks.memoryRegister.mockReset();
    mocks.memoryRegister.mockImplementation(({ program }: { program: Command }) => {
      const memory = program.command("memory").description("Memory commands");
      memory.command("list").action(mocks.memoryListAction);
    });
    mocks.otherRegister.mockReset();
    mocks.otherRegister.mockImplementation(({ program }: { program: Command }) => {
      program.command("other").description("Other commands");
    });
    mocks.memoryListAction.mockReset();
    mocks.loadAforaPluginCliRegistry.mockReset();
    mocks.loadAforaPluginCliRegistry.mockResolvedValue(createCliRegistry());
    mocks.loadAforaPlugins.mockReset();
    mocks.loadAforaPlugins.mockReturnValue({
      ...createCliRegistry(),
      diagnostics: [],
    });
    mocks.resolveManifestActivationPluginIds.mockReset();
    mocks.resolveManifestActivationPluginIds.mockReturnValue([]);
    mocks.applyPluginAutoEnable.mockReset();
    mocks.resolvePluginMetadataSnapshot.mockReset();
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(undefined);
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({
      config,
      changes: [],
      autoEnabledReasons: {},
    }));
    mocks.loadConfig.mockReset();
    mocks.loadConfig.mockReturnValue({} as AforaConfig);
    mocks.getRuntimeConfigSnapshot.mockReset();
    mocks.getRuntimeConfigSnapshot.mockReturnValue(null);
    mocks.readConfigFileSnapshot.mockReset();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: {},
      runtimeConfig: {},
    });
  });

  it("skips plugin CLI registrars when commands already exist", async () => {
    const program = createProgram("memory");

    await registerPluginCliCommands(program, {} as AforaConfig);

    expect(mocks.memoryRegister).not.toHaveBeenCalled();
    expect(mocks.otherRegister).toHaveBeenCalledTimes(1);
  });

  it("skips plugin CLI registrars when an existing command alias matches", async () => {
    const program = createProgram();
    // Alias-only root names (e.g. cron|automations) are owned commands too.
    program.command("mem-core").alias("memory");

    await registerPluginCliCommands(program, {} as AforaConfig);

    expect(mocks.memoryRegister).not.toHaveBeenCalled();
    expect(mocks.otherRegister).toHaveBeenCalledTimes(1);
  });

  it("forwards an explicit env to plugin loading", async () => {
    const env = { AFORA_HOME: "/srv/afora-home" } as NodeJS.ProcessEnv;

    await registerPluginCliCommands(createProgram(), {} as AforaConfig, env);

    const loadOptions = getMockCallObject(mocks.loadAforaPlugins);
    expect(loadOptions.env).toBe(env);
  });

  it("injects gateway-backed node runtime into plugin CLI commands", async () => {
    await registerPluginCliCommands(createProgram(), {} as AforaConfig);

    const loadOptions = getMockCallObject(mocks.loadAforaPlugins) as {
      runtimeOptions?: { nodes?: { list?: unknown; invoke?: unknown } };
    };
    expect(typeof loadOptions.runtimeOptions?.nodes?.list).toBe("function");
    expect(typeof loadOptions.runtimeOptions?.nodes?.invoke).toBe("function");
  });

  it("reuses loaded plugin CLI entries on repeat calls for the same program", async () => {
    const program = createProgram();

    await registerPluginCliCommands(program, {} as AforaConfig);
    await registerPluginCliCommands(program, {} as AforaConfig);

    expect(mocks.loadAforaPlugins).toHaveBeenCalledTimes(1);
  });

  it("reloads plugin CLI entries when the requested primary command changes", async () => {
    const program = createProgram();

    await registerPluginCliCommands(program, {} as AforaConfig, undefined, undefined, {
      primary: "memory",
    });
    await registerPluginCliCommands(program, {} as AforaConfig);

    expect(mocks.loadAforaPlugins).toHaveBeenCalledTimes(2);
  });

  it("reloads plugin CLI entries when config or environment identity changes", async () => {
    const program = createProgram();
    const configA = {} as AforaConfig;
    const configB = { plugins: {} } as AforaConfig;
    const envA = { AFORA_HOME: "/tmp/a" } as NodeJS.ProcessEnv;
    const envB = { AFORA_HOME: "/tmp/b" } as NodeJS.ProcessEnv;

    await registerPluginCliCommands(program, configA, envA);
    await registerPluginCliCommands(program, configA, envB);
    await registerPluginCliCommands(program, configB, envB);

    expect(mocks.loadAforaPlugins).toHaveBeenCalledTimes(3);
  });

  it("loads plugin CLI commands from the auto-enabled config snapshot", async () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });

    await registerPluginCliCommands(createProgram(), rawConfig);

    expectAutoEnabledCliLoad({
      rawConfig,
      autoEnabledConfig,
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });
    const registerOptions = getMockCallObject(mocks.memoryRegister);
    expect(registerOptions.config).toBe(autoEnabledConfig);
  });

  it("loads root-help descriptors from manifests without entering the plugin module loader", async () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(createCliMetadataSnapshot());

    await expect(getPluginCliCommandDescriptors(rawConfig)).resolves.toEqual([
      {
        name: "matrix",
        description: "Matrix channel utilities",
        hasSubcommands: true,
      },
    ]);
    const { renderRootHelpText } = await import("../cli/program/root-help.js");
    const help = await renderRootHelpText({ config: rawConfig });
    expect(help).toContain("matrix *");
    expect(help).toContain("Matrix channel utilities");
    expect(mocks.loadAforaPluginCliRegistry).not.toHaveBeenCalled();
    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith(
      expect.objectContaining({ config: rawConfig }),
    );
    expect(autoEnabledConfig.plugins?.entries?.demo?.enabled).toBe(true);
  });

  it("keeps root-help descriptor load failures quiet", async () => {
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as unknown as typeof process.stderr.write);
    mocks.loadAforaPluginCliRegistry.mockImplementationOnce((options: { logger?: unknown }) => {
      const logger = options.logger as { error?: (message: string) => void };
      logger.error?.("[plugins] stale failed to load from /tmp/stale: boom");
      throw new Error("boom");
    });
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(createLegacyExternalCliMetadataSnapshot());

    await expect(
      getPluginCliCommandDescriptors({
        plugins: { entries: { "legacy-cli": { enabled: true } } },
      } as AforaConfig),
    ).resolves.toEqual([]);

    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it("preserves root help for external plugins without manifest CLI descriptors", async () => {
    const config = {
      plugins: {
        entries: { "legacy-cli": { enabled: true } },
      },
    } as AforaConfig;
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(createLegacyExternalCliMetadataSnapshot());
    mocks.loadAforaPluginCliRegistry.mockResolvedValue({
      cliRegistrars: [
        {
          pluginId: "legacy-cli",
          register: vi.fn(),
          parentPath: [],
          commands: ["legacy"],
          descriptors: [
            {
              name: "legacy",
              description: "Legacy external command",
              hasSubcommands: true,
            },
          ],
          source: "/tmp/legacy-cli/index.js",
        },
      ],
    });

    await expect(getPluginCliCommandDescriptors(config)).resolves.toEqual([
      {
        name: "legacy",
        description: "Legacy external command",
        hasSubcommands: true,
      },
    ]);
    expect(getMockCallObject(mocks.loadAforaPluginCliRegistry).onlyPluginIds).toEqual([
      "legacy-cli",
    ]);
  });

  it("keeps runtime CLI command registration on the full plugin loader for legacy channel plugins", async () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });
    mocks.loadAforaPlugins.mockReturnValue(
      createCliRegistry({
        memoryCommands: ["legacy-channel"],
        memoryDescriptors: [
          {
            name: "legacy-channel",
            description: "Legacy channel commands",
            hasSubcommands: true,
          },
        ],
      }),
    );

    await registerPluginCliCommands(createProgram(), rawConfig, undefined, undefined, {
      mode: "lazy",
    });

    const loadOptions = getMockCallObject(mocks.loadAforaPlugins);
    expect(loadOptions.config).toBe(autoEnabledConfig);
    expect(loadOptions.activationSourceConfig).toBe(rawConfig);
    expect(loadOptions.autoEnabledReasons).toEqual({
      demo: ["demo configured"],
    });
    expect(loadOptions.cache).toBe(false);
    expect(loadOptions.channelPluginLoadIntent).toBe("full");
    expect(mocks.loadAforaPluginCliRegistry).not.toHaveBeenCalled();
  });

  it("lazy-registers descriptor-backed plugin commands on first invocation", async () => {
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as AforaConfig, undefined, undefined, {
      mode: "lazy",
    });

    expect(program.commands.map((command) => command.name())).toEqual(["memory", "other"]);
    expect(mocks.memoryRegister).not.toHaveBeenCalled();
    expect(mocks.otherRegister).toHaveBeenCalledTimes(1);

    await program.parseAsync(["memory", "list"], { from: "user" });

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
    expect(mocks.memoryListAction).toHaveBeenCalledTimes(1);
  });

  it("falls back to eager registration when descriptors do not cover every command root", async () => {
    mocks.loadAforaPlugins.mockReturnValue(
      createCliRegistry({
        memoryCommands: ["memory", "memory-admin"],
        memoryDescriptors: [
          {
            name: "memory",
            description: "Memory commands",
            hasSubcommands: true,
          },
        ],
      }),
    );
    mocks.memoryRegister.mockImplementation(({ program }: { program: Command }) => {
      program.command("memory");
      program.command("memory-admin");
    });

    await registerPluginCliCommands(createProgram(), {} as AforaConfig, undefined, undefined, {
      mode: "lazy",
    });

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
  });

  it("registers a selected plugin primary eagerly during lazy startup", async () => {
    const program = createProgram();
    program.exitOverride();
    mocks.resolveManifestActivationPluginIds.mockReturnValue(["memory-core"]);

    await registerPluginCliCommands(program, {} as AforaConfig, undefined, undefined, {
      mode: "lazy",
      primary: "memory",
    });

    expect(
      program.commands.reduce((count, command) => count + (command.name() === "memory" ? 1 : 0), 0),
    ).toBe(1);
    const loadOptions = getMockCallObject(mocks.loadAforaPlugins);
    expect(loadOptions.onlyPluginIds).toEqual(["memory-core"]);

    await program.parseAsync(["memory", "list"], { from: "user" });

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
    expect(mocks.memoryListAction).toHaveBeenCalledTimes(1);
  });

  it("registers nested plugin commands against their parent command", async () => {
    const program = createProgram("nodes");
    program.exitOverride();
    mocks.resolveManifestActivationPluginIds.mockReturnValue(["memory-core"]);
    mocks.loadAforaPlugins.mockReturnValue(
      createCliRegistry({
        memoryParentPath: ["nodes"],
        memoryCommands: ["canvas"],
        memoryDescriptors: [
          {
            name: "canvas",
            description: "Canvas commands",
            hasSubcommands: true,
          },
        ],
      }),
    );
    mocks.memoryRegister.mockImplementation(({ program: programLocal }: { program: Command }) => {
      const canvas = programLocal.command("canvas").description("Canvas commands");
      canvas.command("snapshot").action(mocks.memoryListAction);
    });

    await registerPluginCliCommands(program, {} as AforaConfig, undefined, undefined, {
      mode: "lazy",
      primary: "nodes",
    });

    const nodes = program.commands.find((command) => command.name() === "nodes");
    expect(nodes?.commands.map((command) => command.name())).toEqual(["canvas"]);

    await program.parseAsync(["nodes", "canvas", "snapshot"], { from: "user" });

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
    expect(getMockCallObject(mocks.memoryRegister).program).toBe(nodes);
    expect(mocks.memoryListAction).toHaveBeenCalledTimes(1);
  });

  it("scopes full CLI loading through CLI metadata when manifest planning finds no plugin match", async () => {
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as AforaConfig, undefined, undefined, {
      mode: "lazy",
      primary: "memory",
    });

    expect(mocks.loadAforaPluginCliRegistry).toHaveBeenCalled();
    const loadOptions = getMockCallObject(mocks.loadAforaPlugins);
    expect(loadOptions.onlyPluginIds).toEqual(["memory-core"]);
  });

  it("scopes nested CLI loading through CLI metadata parent paths", async () => {
    const nestedRegistry = createCliRegistry({
      memoryParentPath: ["nodes"],
      memoryCommands: ["canvas"],
      memoryDescriptors: [
        {
          name: "canvas",
          description: "Canvas commands",
          hasSubcommands: true,
        },
      ],
    });
    mocks.loadAforaPluginCliRegistry.mockResolvedValue(nestedRegistry);
    mocks.loadAforaPlugins.mockReturnValue(nestedRegistry);
    const program = createProgram("nodes");
    program.exitOverride();

    await registerPluginCliCommands(program, {} as AforaConfig, undefined, undefined, {
      mode: "lazy",
      primary: "nodes",
    });

    const loadOptions = getMockCallObject(mocks.loadAforaPlugins);
    expect(loadOptions.onlyPluginIds).toEqual(["memory-core"]);
  });

  it("skips full plugin runtime loading when no metadata owns the requested primary", async () => {
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as AforaConfig, undefined, undefined, {
      mode: "lazy",
      primary: "missing-command",
    });

    expect(mocks.loadAforaPluginCliRegistry).toHaveBeenCalled();
    expect(mocks.loadAforaPlugins).not.toHaveBeenCalled();
    expect(program.commands.map((command) => command.name())).not.toContain("missing-command");
  });

  it("reuses the validated cold snapshot runtime config without a second config read", async () => {
    const snapshotConfig = { plugins: { enabled: true } } as AforaConfig;
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: true,
      config: {},
      runtimeConfig: snapshotConfig,
    });

    await expect(loadValidatedConfigForPluginRegistration()).resolves.toBe(snapshotConfig);
    expect(mocks.getRuntimeConfigSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });

  it("skips unrelated plugin validation for cold plugin-owned CLI commands", async () => {
    const snapshotConfig = { plugins: { enabled: true } } as AforaConfig;
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: true,
      config: {},
      runtimeConfig: snapshotConfig,
    });

    await expect(
      loadValidatedConfigForPluginRegistration({ skipPluginValidation: true }),
    ).resolves.toBe(snapshotConfig);
    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({ skipPluginValidation: true });
  });

  it("preserves an already-active runtime config snapshot", async () => {
    const snapshotConfig = { plugins: { enabled: true } } as AforaConfig;
    const activeConfig = { plugins: { enabled: false } } as AforaConfig;
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: true,
      config: {},
      runtimeConfig: snapshotConfig,
    });
    mocks.getRuntimeConfigSnapshot.mockReturnValueOnce(activeConfig);

    await expect(loadValidatedConfigForPluginRegistration()).resolves.toBe(activeConfig);
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });

  it("short-circuits validated plugin CLI config when the snapshot is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: false,
      config: { plugins: { load: { paths: ["/tmp/evil"] } } },
    });

    await expect(loadValidatedConfigForPluginRegistration()).resolves.toBeNull();
    expect(mocks.getRuntimeConfigSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });

  it("skips plugin CLI registration from validated config when the snapshot is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: false,
      config: {},
    });

    await expect(registerPluginCliCommandsFromValidatedConfig(createProgram())).resolves.toBeNull();
    expect(mocks.getRuntimeConfigSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadAforaPlugins).not.toHaveBeenCalled();
  });
});
