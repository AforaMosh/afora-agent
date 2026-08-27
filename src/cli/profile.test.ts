// Profile CLI tests cover profile selection, persistence, and command wiring.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGatewayPort } from "../config/paths.js";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "afora",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "afora", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("leaves gateway --dev for subcommands after leading root options", () => {
    const res = parseCliProfileArgs([
      "node",
      "afora",
      "--no-color",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual([
      "node",
      "afora",
      "--no-color",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "afora", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "afora", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "afora", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "afora", "status"]);
  });

  it("parses interleaved --profile after the command token", () => {
    const res = parseCliProfileArgs(["node", "afora", "status", "--profile", "work", "--deep"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "afora", "status", "--deep"]);
  });

  it("preserves Matrix QA --profile for the command parser", () => {
    const res = parseCliProfileArgs([
      "node",
      "afora",
      "qa",
      "matrix",
      "--profile",
      "fast",
      "--fail-fast",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual([
      "node",
      "afora",
      "qa",
      "matrix",
      "--profile",
      "fast",
      "--fail-fast",
    ]);
  });

  it("preserves Matrix QA --profile after leading root options", () => {
    const res = parseCliProfileArgs([
      "node",
      "afora",
      "--no-color",
      "qa",
      "matrix",
      "--profile=fast",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "afora", "--no-color", "qa", "matrix", "--profile=fast"]);
  });

  it("parses qa run --profile smoke-ci as a root profile", () => {
    const res = parseCliProfileArgs([
      "node",
      "afora",
      "qa",
      "run",
      "--profile",
      "smoke-ci",
      "--category",
      "agent-runtime.agent-turn-execution",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("smoke-ci");
    expect(res.argv).toEqual([
      "node",
      "afora",
      "qa",
      "run",
      "--category",
      "agent-runtime.agent-turn-execution",
    ]);
  });

  it("parses qa run --profile=release self-check invocations as root profiles", () => {
    const res = parseCliProfileArgs([
      "node",
      "afora",
      "qa",
      "run",
      "--profile=release",
      "--output",
      "qa-report.md",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("release");
    expect(res.argv).toEqual(["node", "afora", "qa", "run", "--output", "qa-report.md"]);
  });

  it("preserves qa run --qa-profile for the command parser", () => {
    const res = parseCliProfileArgs([
      "node",
      "afora",
      "qa",
      "run",
      "--qa-profile",
      "smoke-ci",
      "--surface",
      "agent-runtime",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual([
      "node",
      "afora",
      "qa",
      "run",
      "--qa-profile",
      "smoke-ci",
      "--surface",
      "agent-runtime",
    ]);
  });

  it("parses arbitrary qa run --profile values as root profiles", () => {
    const res = parseCliProfileArgs([
      "node",
      "afora",
      "qa",
      "run",
      "--profile",
      "work",
      "--output",
      "qa-report.md",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "afora", "qa", "run", "--output", "qa-report.md"]);
  });

  it("parses arbitrary qa run --profile= values as root profiles", () => {
    const res = parseCliProfileArgs([
      "node",
      "afora",
      "qa",
      "run",
      "--profile=work",
      "--output",
      "qa-report.md",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "afora", "qa", "run", "--output", "qa-report.md"]);
  });

  it("still parses root --profile before qa run", () => {
    const res = parseCliProfileArgs([
      "node",
      "afora",
      "--profile",
      "work",
      "qa",
      "run",
      "--qa-profile",
      "smoke-ci",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "afora", "qa", "run", "--qa-profile", "smoke-ci"]);
  });

  it("still parses root --profile before Matrix QA", () => {
    const res = parseCliProfileArgs([
      "node",
      "afora",
      "--profile",
      "work",
      "qa",
      "matrix",
      "--fail-fast",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "afora", "qa", "matrix", "--fail-fast"]);
  });

  it("parses interleaved --dev after the command token", () => {
    const res = parseCliProfileArgs(["node", "afora", "status", "--dev"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "afora", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "afora", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it.each([
    ["--dev first", ["node", "afora", "--dev", "--profile", "work", "status"]],
    ["--profile first", ["node", "afora", "--profile", "work", "--dev", "status"]],
    ["interleaved after command", ["node", "afora", "status", "--profile", "work", "--dev"]],
  ])("rejects combining --dev with --profile (%s)", (_name, argv) => {
    const res = parseCliProfileArgs(argv);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join(path.resolve("/home/peter"), ".afora-dev");
    expect(env.AFORA_PROFILE).toBe("dev");
    expect(env.AFORA_STATE_DIR).toBe(expectedStateDir);
    expect(env.AFORA_CONFIG_PATH).toBe(path.join(expectedStateDir, "afora.json"));
    expect(env.AFORA_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      AFORA_PROFILE: "prod",
      AFORA_STATE_DIR: "/custom",
      AFORA_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.AFORA_PROFILE).toBe("dev");
    expect(env.AFORA_STATE_DIR).toBe("/custom");
    expect(env.AFORA_GATEWAY_PORT).toBe("19099");
    expect(env.AFORA_CONFIG_PATH).toBe(path.join("/custom", "afora.json"));
  });

  it.each([
    { name: "default service to named profile", inheritedProfile: undefined, selected: "work" },
    { name: "named service to different profile", inheritedProfile: "main", selected: "work" },
    { name: "named service to dev", inheritedProfile: "main", selected: "dev" },
  ])("replaces the complete service selector bundle: $name", ({ inheritedProfile, selected }) => {
    const inheritedStateDir = inheritedProfile
      ? `/home/peter/.afora-${inheritedProfile}`
      : "/home/peter/.afora";
    const env: Record<string, string | undefined> = {
      AFORA_PROFILE: inheritedProfile,
      AFORA_STATE_DIR: inheritedStateDir,
      AFORA_CONFIG_PATH: path.join(inheritedStateDir, "afora.json"),
      AFORA_GATEWAY_PORT: "18789",
      AFORA_LAUNCHD_LABEL: inheritedProfile
        ? `ai.afora.${inheritedProfile}`
        : "ai.afora.gateway",
      AFORA_SYSTEMD_UNIT: inheritedProfile
        ? `afora-gateway-${inheritedProfile}.service`
        : "afora-gateway.service",
      AFORA_WINDOWS_TASK_NAME: inheritedProfile
        ? `Afora Gateway (${inheritedProfile})`
        : "Afora Gateway",
      AFORA_SERVICE_MARKER: "afora",
      AFORA_SERVICE_KIND: "gateway",
    };

    applyCliProfileEnv({ profile: selected, env, homedir: () => "/home/peter" });

    expect(env.AFORA_PROFILE).toBe(selected);
    expect(env.AFORA_STATE_DIR).toBe(`/home/peter/.afora-${selected}`);
    expect(env.AFORA_CONFIG_PATH).toBeUndefined();
    expect(env.AFORA_GATEWAY_PORT).toBe(selected === "dev" ? "19001" : undefined);
    expect(env.AFORA_LAUNCHD_LABEL).toBeUndefined();
    expect(env.AFORA_SYSTEMD_UNIT).toBeUndefined();
    expect(env.AFORA_WINDOWS_TASK_NAME).toBeUndefined();
  });

  it("lets selected config or profile derivation resolve the port after stale service removal", () => {
    const env: Record<string, string | undefined> = {
      AFORA_PROFILE: "main",
      AFORA_STATE_DIR: "/home/peter/.afora-main",
      AFORA_CONFIG_PATH: "/home/peter/.afora-main/afora.json",
      AFORA_GATEWAY_PORT: "18789",
      AFORA_LAUNCHD_LABEL: "ai.afora.main",
      AFORA_SYSTEMD_UNIT: "afora-gateway-main.service",
      AFORA_WINDOWS_TASK_NAME: "Afora Gateway (main)",
      AFORA_SERVICE_MARKER: "afora",
      AFORA_SERVICE_KIND: "gateway",
    };

    applyCliProfileEnv({ profile: "work", env, homedir: () => "/home/peter" });

    expect(resolveGatewayPort({ gateway: { port: 21999 } }, env)).toBe(21999);
    expect(resolveGatewayPort(undefined, env)).not.toBe(18789);
  });

  it("supports legacy gateway services without a service kind", () => {
    const env: Record<string, string | undefined> = {
      AFORA_PROFILE: "main",
      AFORA_STATE_DIR: "/home/peter/.afora-main",
      AFORA_CONFIG_PATH: "/home/peter/.afora-main/afora.json",
      AFORA_GATEWAY_PORT: "18789",
      AFORA_SERVICE_MARKER: "afora",
    };

    applyCliProfileEnv({ profile: "work", env, homedir: () => "/home/peter" });

    expect(env.AFORA_CONFIG_PATH).toBeUndefined();
    expect(env.AFORA_GATEWAY_PORT).toBeUndefined();
  });

  it("preserves node service selectors when selecting a CLI profile", () => {
    const env: Record<string, string | undefined> = {
      AFORA_PROFILE: "main",
      AFORA_STATE_DIR: "/home/peter/.afora-main",
      AFORA_CONFIG_PATH: "/home/peter/.afora-main/afora.json",
      AFORA_GATEWAY_PORT: "19999",
      AFORA_LAUNCHD_LABEL: "ai.afora.node",
      AFORA_SYSTEMD_UNIT: "afora-node.service",
      AFORA_WINDOWS_TASK_NAME: "Afora Node",
      AFORA_SERVICE_MARKER: "afora",
      AFORA_SERVICE_KIND: "node",
    };

    applyCliProfileEnv({ profile: "work", env, homedir: () => "/home/peter" });

    expect(env.AFORA_GATEWAY_PORT).toBe("19999");
    expect(env.AFORA_LAUNCHD_LABEL).toBe("ai.afora.node");
    expect(env.AFORA_SYSTEMD_UNIT).toBe("afora-node.service");
    expect(env.AFORA_WINDOWS_TASK_NAME).toBe("Afora Node");
  });

  it.each([
    {
      name: "the default profile without a profile marker",
      inheritedProfile: undefined,
      inheritedStateDir: "/home/peter/.afora",
    },
    {
      name: "the explicitly marked default profile",
      inheritedProfile: "default",
      inheritedStateDir: "/home/peter/.afora",
    },
    {
      name: "another named profile",
      inheritedProfile: "main",
      inheritedStateDir: "/home/peter/.afora-main",
    },
    {
      name: "a home-relative default state directory",
      inheritedProfile: undefined,
      inheritedStateDir: "~/.afora",
    },
  ])(
    "switches inherited canonical state from $name to the requested profile",
    ({ inheritedProfile, inheritedStateDir }) => {
      const env: Record<string, string | undefined> = {
        AFORA_PROFILE: inheritedProfile,
        AFORA_STATE_DIR: inheritedStateDir,
        AFORA_CONFIG_PATH: path.join(inheritedStateDir, "afora.json"),
      };

      applyCliProfileEnv({ profile: "work", env, homedir: () => "/home/peter" });

      const expectedStateDir = path.join(path.resolve("/home/peter"), ".afora-work");
      expect(env.AFORA_PROFILE).toBe("work");
      expect(env.AFORA_STATE_DIR).toBe(expectedStateDir);
      expect(env.AFORA_CONFIG_PATH).toBe(path.join(expectedStateDir, "afora.json"));
    },
  );

  it("preserves an explicit config outside inherited canonical profile state", () => {
    const env: Record<string, string | undefined> = {
      AFORA_PROFILE: "main",
      AFORA_STATE_DIR: "/home/peter/.afora-main",
      AFORA_CONFIG_PATH: "/srv/afora/custom.json",
    };

    applyCliProfileEnv({ profile: "work", env, homedir: () => "/home/peter" });

    expect(env.AFORA_STATE_DIR).toBe("/home/peter/.afora-work");
    expect(env.AFORA_CONFIG_PATH).toBe("/srv/afora/custom.json");
  });

  it.each(["afora-gateway-main", "afora-gateway-main.service"])(
    "drops inherited canonical service identities when switching profiles (%s)",
    (systemdUnit) => {
      const env: Record<string, string | undefined> = {
        AFORA_PROFILE: "main",
        AFORA_STATE_DIR: "/home/peter/.afora-main",
        AFORA_CONFIG_PATH: "/home/peter/.afora-main/afora.json",
        AFORA_LAUNCHD_LABEL: "ai.afora.main",
        AFORA_SYSTEMD_UNIT: systemdUnit,
        AFORA_WINDOWS_TASK_NAME: "Afora Gateway (main)",
      };

      applyCliProfileEnv({ profile: "work", env, homedir: () => "/home/peter" });

      expect(env.AFORA_LAUNCHD_LABEL).toBeUndefined();
      expect(env.AFORA_SYSTEMD_UNIT).toBeUndefined();
      expect(env.AFORA_WINDOWS_TASK_NAME).toBeUndefined();
    },
  );

  it("preserves explicit custom service identities when switching profiles", () => {
    const env: Record<string, string | undefined> = {
      AFORA_PROFILE: "main",
      AFORA_LAUNCHD_LABEL: "com.example.gateway",
      AFORA_SYSTEMD_UNIT: "custom-gateway.service",
      AFORA_WINDOWS_TASK_NAME: "Custom Gateway",
    };

    applyCliProfileEnv({ profile: "work", env, homedir: () => "/home/peter" });

    expect(env.AFORA_LAUNCHD_LABEL).toBe("com.example.gateway");
    expect(env.AFORA_SYSTEMD_UNIT).toBe("custom-gateway.service");
    expect(env.AFORA_WINDOWS_TASK_NAME).toBe("Custom Gateway");
  });

  it.each([
    { inheritedProfile: "Main", selectedProfile: "main" },
    { inheritedProfile: "main", selectedProfile: "Main" },
  ])(
    "keeps case-distinct named profiles isolated ($inheritedProfile to $selectedProfile)",
    ({ inheritedProfile, selectedProfile }) => {
      const inheritedStateDir = `/home/peter/.afora-${inheritedProfile}`;
      const env: Record<string, string | undefined> = {
        AFORA_PROFILE: inheritedProfile,
        AFORA_STATE_DIR: inheritedStateDir,
        AFORA_CONFIG_PATH: path.join(inheritedStateDir, "afora.json"),
      };

      applyCliProfileEnv({ profile: selectedProfile, env, homedir: () => "/home/peter" });

      const expectedStateDir = `/home/peter/.afora-${selectedProfile}`;
      expect(env.AFORA_PROFILE).toBe(selectedProfile);
      expect(env.AFORA_STATE_DIR).toBe(expectedStateDir);
      expect(env.AFORA_CONFIG_PATH).toBe(path.join(expectedStateDir, "afora.json"));
    },
  );

  it("treats case variants of the default profile as the same canonical profile", () => {
    const stateDir = "/home/peter/.afora";
    const env: Record<string, string | undefined> = {
      AFORA_PROFILE: "Default",
      AFORA_STATE_DIR: stateDir,
      AFORA_CONFIG_PATH: path.join(stateDir, "afora.json"),
    };

    applyCliProfileEnv({ profile: "default", env, homedir: () => "/home/peter" });

    expect(env.AFORA_PROFILE).toBe("default");
    expect(env.AFORA_STATE_DIR).toBe(stateDir);
    expect(env.AFORA_CONFIG_PATH).toBe(path.join(stateDir, "afora.json"));
  });

  it.each([
    {
      name: "the default profile",
      inheritedProfile: undefined,
      inheritedConfigPath: "/home/peter/.AforaMosh/afora-agent.json",
    },
    {
      name: "another named profile",
      inheritedProfile: "main",
      inheritedConfigPath: "/home/peter/.afora-main/afora.json",
    },
    {
      name: "a home-relative named profile",
      inheritedProfile: "main",
      inheritedConfigPath: "~/.afora-main/afora.json",
    },
  ])(
    "switches an inherited $name config when the state directory is absent",
    ({ inheritedProfile, inheritedConfigPath }) => {
      const env: Record<string, string | undefined> = {
        AFORA_PROFILE: inheritedProfile,
        AFORA_CONFIG_PATH: inheritedConfigPath,
      };

      applyCliProfileEnv({ profile: "work", env, homedir: () => "/home/peter" });

      const expectedStateDir = "/home/peter/.afora-work";
      expect(env.AFORA_PROFILE).toBe("work");
      expect(env.AFORA_STATE_DIR).toBe(expectedStateDir);
      expect(env.AFORA_CONFIG_PATH).toBe(path.join(expectedStateDir, "afora.json"));
    },
  );

  it("uses AFORA_HOME when deriving profile state dir", () => {
    const env: Record<string, string | undefined> = {
      AFORA_HOME: "/srv/afora-home",
      HOME: "/home/other",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/fallback",
    });

    const resolvedHome = path.resolve("/srv/afora-home");
    expect(env.AFORA_STATE_DIR).toBe(path.join(resolvedHome, ".afora-work"));
    expect(env.AFORA_CONFIG_PATH).toBe(
      path.join(resolvedHome, ".afora-work", "afora.json"),
    );
  });
});

describe("formatCliCommand", () => {
  it.each([
    {
      name: "no profile is set",
      cmd: "afora doctor --fix",
      env: {},
      expected: "afora doctor --fix",
    },
    {
      name: "profile is default",
      cmd: "afora doctor --fix",
      env: { AFORA_PROFILE: "default" },
      expected: "afora doctor --fix",
    },
    {
      name: "profile is Default (case-insensitive)",
      cmd: "afora doctor --fix",
      env: { AFORA_PROFILE: "Default" },
      expected: "afora doctor --fix",
    },
    {
      name: "profile is invalid",
      cmd: "afora doctor --fix",
      env: { AFORA_PROFILE: "bad profile" },
      expected: "afora doctor --fix",
    },
    {
      name: "--profile is already present",
      cmd: "afora --profile work doctor --fix",
      env: { AFORA_PROFILE: "work" },
      expected: "afora --profile work doctor --fix",
    },
    {
      name: "--dev is already present",
      cmd: "afora --dev doctor",
      env: { AFORA_PROFILE: "dev" },
      expected: "afora --dev doctor",
    },
  ])("returns command unchanged when $name", ({ cmd, env, expected }) => {
    expect(formatCliCommand(cmd, env)).toBe(expected);
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("afora doctor --fix", { AFORA_PROFILE: "work" })).toBe(
      "afora --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("afora doctor --fix", { AFORA_PROFILE: "  jbafora  " })).toBe(
      "afora --profile jbafora doctor --fix",
    );
  });

  it("handles command with no args after afora", () => {
    expect(formatCliCommand("afora", { AFORA_PROFILE: "test" })).toBe(
      "afora --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm afora doctor", { AFORA_PROFILE: "work" })).toBe(
      "pnpm afora --profile work doctor",
    );
  });

  it("inserts --container when a container hint is set", () => {
    expect(
      formatCliCommand("afora gateway status --deep", { AFORA_CONTAINER_HINT: "demo" }),
    ).toBe("afora --container demo gateway status --deep");
  });

  it("ignores unsafe container hints", () => {
    expect(
      formatCliCommand("afora gateway status --deep", {
        AFORA_CONTAINER_HINT: "demo; rm -rf /",
      }),
    ).toBe("afora gateway status --deep");
  });

  it("preserves both --container and --profile hints", () => {
    expect(
      formatCliCommand("afora doctor", {
        AFORA_CONTAINER_HINT: "demo",
        AFORA_PROFILE: "work",
      }),
    ).toBe("afora --container demo doctor");
  });

  it("does not prepend --container for update commands", () => {
    expect(formatCliCommand("afora update", { AFORA_CONTAINER_HINT: "demo" })).toBe(
      "afora update",
    );
    expect(
      formatCliCommand("pnpm afora update --channel beta", { AFORA_CONTAINER_HINT: "demo" }),
    ).toBe("pnpm afora update --channel beta");
  });
});
