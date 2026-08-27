// Run-main profile env tests cover profile environment handling in the CLI entrypoint.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";

const fileState = vi.hoisted(() => ({
  hasCliDotEnv: false,
}));

const dotenvState = vi.hoisted(() => {
  const state = {
    profileAtDotenvLoad: undefined as string | undefined,
    containerAtDotenvLoad: undefined as string | undefined,
  };
  return {
    state,
    loadDotEnv: vi.fn(() => {
      state.profileAtDotenvLoad = process.env.AFORA_PROFILE;
      state.containerAtDotenvLoad = process.env.AFORA_CONTAINER;
    }),
  };
});

const maybeRunCliInContainerMock = vi.hoisted(() =>
  vi.fn((argv: string[]) => ({ handled: false, argv })),
);

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  type ExistsSyncPath = Parameters<typeof actual.existsSync>[0];
  return {
    ...actual,
    existsSync: vi.fn((target: ExistsSyncPath) => {
      if (typeof target === "string" && target.endsWith(".env")) {
        return fileState.hasCliDotEnv;
      }
      return actual.existsSync(target);
    }),
  };
});

vi.mock("./dotenv.js", () => ({
  loadCliDotEnv: dotenvState.loadDotEnv,
}));

vi.mock("../infra/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/env.js")>()),
  normalizeEnv: vi.fn(),
}));

vi.mock("../infra/runtime-guard.js", () => ({
  assertSupportedRuntime: vi.fn(),
}));

vi.mock("../infra/path-env.js", () => ({
  ensureAforaCliOnPath: vi.fn(),
}));

vi.mock("./route.js", () => ({
  tryRouteCli: vi.fn(async () => true),
}));

vi.mock("./windows-argv.js", () => ({
  normalizeWindowsArgv: (argv: string[]) => argv,
}));

vi.mock("./container-target.js", async () => {
  const actual =
    await vi.importActual<typeof import("./container-target.js")>("./container-target.js");
  return {
    ...actual,
    maybeRunCliInContainer: maybeRunCliInContainerMock,
  };
});

import { runCli } from "./run-main.js";

describe("runCli profile env bootstrap", () => {
  const envSnapshot = captureEnv([
    "AFORA_PROFILE",
    "AFORA_STATE_DIR",
    "AFORA_CONFIG_PATH",
    "AFORA_CONTAINER",
    "AFORA_GATEWAY_PORT",
    "AFORA_GATEWAY_URL",
    "AFORA_GATEWAY_TOKEN",
    "AFORA_GATEWAY_PASSWORD",
  ]);

  beforeEach(() => {
    deleteTestEnvValue("AFORA_PROFILE");
    deleteTestEnvValue("AFORA_STATE_DIR");
    deleteTestEnvValue("AFORA_CONFIG_PATH");
    deleteTestEnvValue("AFORA_CONTAINER");
    deleteTestEnvValue("AFORA_GATEWAY_PORT");
    deleteTestEnvValue("AFORA_GATEWAY_URL");
    deleteTestEnvValue("AFORA_GATEWAY_TOKEN");
    deleteTestEnvValue("AFORA_GATEWAY_PASSWORD");
    dotenvState.state.profileAtDotenvLoad = undefined;
    dotenvState.state.containerAtDotenvLoad = undefined;
    dotenvState.loadDotEnv.mockClear();
    maybeRunCliInContainerMock.mockClear();
    fileState.hasCliDotEnv = false;
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("applies --profile before dotenv loading", async () => {
    fileState.hasCliDotEnv = true;
    await runCli(["node", "afora", "--profile", "rawdog", "status"]);

    expect(dotenvState.loadDotEnv).toHaveBeenCalledOnce();
    expect(dotenvState.state.profileAtDotenvLoad).toBe("rawdog");
    expect(process.env.AFORA_PROFILE).toBe("rawdog");
  });

  it("rejects --container combined with --profile", async () => {
    await expect(
      runCli(["node", "afora", "--container", "demo", "--profile", "rawdog", "status"]),
    ).rejects.toThrow("--container cannot be combined with --profile/--dev");

    expect(dotenvState.loadDotEnv).not.toHaveBeenCalled();
    expect(process.env.AFORA_PROFILE).toBe("rawdog");
  });

  it("rejects --container combined with interleaved --profile", async () => {
    await expect(
      runCli(["node", "afora", "status", "--container", "demo", "--profile", "rawdog"]),
    ).rejects.toThrow("--container cannot be combined with --profile/--dev");
  });

  it("rejects --container combined with interleaved --dev", async () => {
    await expect(
      runCli(["node", "afora", "status", "--container", "demo", "--dev"]),
    ).rejects.toThrow("--container cannot be combined with --profile/--dev");
  });

  it("does not let dotenv change container target resolution", async () => {
    fileState.hasCliDotEnv = true;
    dotenvState.loadDotEnv.mockImplementationOnce(() => {
      process.env.AFORA_CONTAINER = "demo";
      dotenvState.state.profileAtDotenvLoad = process.env.AFORA_PROFILE;
      dotenvState.state.containerAtDotenvLoad = process.env.AFORA_CONTAINER;
    });

    await runCli(["node", "afora", "status"]);

    expect(dotenvState.loadDotEnv).toHaveBeenCalledOnce();
    expect(process.env.AFORA_CONTAINER).toBe("demo");
    expect(dotenvState.state.containerAtDotenvLoad).toBe("demo");
    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(["node", "afora", "status"]);
    expect(maybeRunCliInContainerMock).toHaveReturnedWith({
      handled: false,
      argv: ["node", "afora", "status"],
    });
  });

  it("allows container mode when AFORA_PROFILE is already set in env", async () => {
    setTestEnvValue("AFORA_PROFILE", "work");

    await expect(
      runCli(["node", "afora", "--container", "demo", "status"]),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["AFORA_GATEWAY_PORT", "19001"],
    ["AFORA_GATEWAY_URL", "ws://127.0.0.1:18789"],
    ["AFORA_GATEWAY_TOKEN", "demo-token"],
    ["AFORA_GATEWAY_PASSWORD", "demo-password"],
  ])("allows container mode when %s is set in env", async (key, value) => {
    setTestEnvValue(key, value);

    await expect(
      runCli(["node", "afora", "--container", "demo", "status"]),
    ).resolves.toBeUndefined();
  });

  it("allows container mode when only AFORA_STATE_DIR is set in env", async () => {
    setTestEnvValue("AFORA_STATE_DIR", "/tmp/afora-host-state");

    await expect(
      runCli(["node", "afora", "--container", "demo", "status"]),
    ).resolves.toBeUndefined();
  });

  it("allows container mode when only AFORA_CONFIG_PATH is set in env", async () => {
    setTestEnvValue("AFORA_CONFIG_PATH", "/tmp/afora-host-state/afora.json");

    await expect(
      runCli(["node", "afora", "--container", "demo", "status"]),
    ).resolves.toBeUndefined();
  });
});
