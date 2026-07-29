// Covers canonical config writes, include ownership, and authored env refs.
import { describe, expect, it, vi } from "vitest";
import { collectChangedPaths } from "./config-change-paths.js";
import { applyUnsetPathsForWrite } from "./config-path-mutation.js";
import { restoreEnvRefsFromMap, resolveWriteEnvSnapshotForPath } from "./env-preserve.js";
import { formatConfigValidationFailure } from "./io.write-errors.js";
import { resolvePersistCandidateForWrite } from "./io.write-prepare.js";
import { createMergePatch } from "./merge-patch.js";
import type { OpenClawConfig } from "./types.js";

vi.unmock("../agents/agent-scope-config.js");

type PersistInput = Parameters<typeof resolvePersistCandidateForWrite>[0];
type WriteCase = {
  name: string;
  current: unknown;
  next: unknown;
  source?: unknown;
  authored?: unknown;
  options?: Partial<PersistInput>;
  expected?: unknown;
  error?: string;
  verify?: (persisted: OpenClawConfig) => void;
};

const main = { default: true };

const writeCases: WriteCase[] = [
  {
    name: "persists caller changes onto resolved config without leaking runtime defaults",
    current: {
      gateway: { port: 18789 },
      agents: { defaults: { cliBackend: "codex" } },
      messages: { ackReaction: "eyes" },
      sessions: { persistence: true },
    },
    source: { gateway: { port: 18789 } },
    next: { gateway: { port: 18789, auth: { mode: "token" } } },
    expected: { gateway: { port: 18789, auth: { mode: "token" } } },
  },
  {
    name: "rejects narrowed canonical writes that silently drop an agent",
    current: { agents: { entries: { main: { default: true }, worker: {} } } },
    next: { agents: { entries: { worker: { default: true } } } },
    error: "Config write would drop agent roster entries without an explicit deletion: main.",
  },
  {
    name: "allows explicitly authorized canonical agent removal",
    current: { agents: { entries: { main: { default: true }, worker: {} } } },
    next: { agents: { entries: { worker: { default: true } } } },
    options: { allowedAgentRosterRemovals: ["main"] },
    expected: { agents: { entries: { worker: { default: true } } } },
  },
  {
    name: "rejects roster unsets that remove an unauthorized entry",
    current: { agents: { entries: { main: { default: true }, worker: {} } } },
    next: { agents: { entries: { main: { default: true }, worker: {} } } },
    options: {
      unsetPaths: [["agents", "entries"]],
      allowedAgentRosterRemovals: ["main"],
    },
    error: "Config write would drop agent roster entries without an explicit deletion: worker.",
  },
  {
    name: "preserves untouched include-owned subtrees during unrelated writes",
    current: { agents: { defaults: { model: "openai/gpt-5.4" } }, gateway: { mode: "local" } },
    authored: { agents: { $include: "./config/agents.json" }, gateway: { mode: "local" } },
    next: {
      agents: { defaults: { model: "openai/gpt-5.4" } },
      gateway: { mode: "local", port: 18789 },
    },
    expected: {
      agents: { $include: "./config/agents.json" },
      gateway: { mode: "local", port: 18789 },
    },
  },
  {
    name: "allows removing root-authored sibling keys beside an include",
    current: { gateway: { mode: "local", legacyKey: true } },
    authored: { gateway: { $include: "./config/gateway.json", legacyKey: true } },
    next: { gateway: { mode: "local" } },
    expected: { gateway: { $include: "./config/gateway.json" } },
  },
  {
    name: "allows nested root-authored sibling edits without flattening included values",
    current: { gateway: { mode: "local", auth: { mode: "token", token: "old" } } },
    authored: { gateway: { $include: "./config/gateway.json", auth: { token: "old" } } },
    next: { gateway: { mode: "local", auth: { mode: "none", token: "new", strategy: "strict" } } },
    expected: {
      gateway: {
        $include: "./config/gateway.json",
        auth: { token: "new", mode: "none", strategy: "strict" },
      },
    },
  },
  {
    name: "does not copy runtime-normalized include values into root-authored siblings",
    current: { gateway: { tls: { certPath: "/home/test/cert.pem", enabled: false } } },
    source: { gateway: { tls: { certPath: "~/cert.pem", enabled: false } } },
    authored: { gateway: { $include: "./config/gateway.json", tls: { enabled: false } } },
    next: { gateway: { tls: { certPath: "~/cert.pem", enabled: true } } },
    expected: { gateway: { $include: "./config/gateway.json", tls: { enabled: true } } },
  },
  {
    name: "rejects included-value edits beside root-authored sibling edits",
    current: { gateway: { mode: "local", legacyKey: "old" } },
    authored: { gateway: { $include: "./config/gateway.json", legacyKey: "old" } },
    next: { gateway: { mode: "remote", legacyKey: "new" } },
    error: "Config write would flatten $include-owned config at gateway",
  },
  {
    name: "preserves include-owned array entries across runtime-only normalization",
    current: {
      plugins: { load: { paths: ["/home/test/plugin"] } },
      gateway: { mode: "local" },
    },
    source: { plugins: { load: { paths: ["~/plugin"] } }, gateway: { mode: "local" } },
    authored: {
      plugins: { load: { paths: [{ $include: "./config/plugin-path.json" }] } },
      gateway: { mode: "local" },
    },
    next: {
      plugins: { load: { paths: ["~/plugin"] } },
      gateway: { mode: "local", port: 18789 },
    },
    expected: {
      plugins: { load: { paths: [{ $include: "./config/plugin-path.json" }] } },
      gateway: { mode: "local", port: 18789 },
    },
  },
  {
    name: "rejects writes that change include-owned array entries",
    current: { plugins: { load: { paths: ["/included"] } } },
    authored: { plugins: { load: { paths: [{ $include: "./config/plugin-path.json" }] } } },
    next: { plugins: { load: { paths: ["/changed"] } } },
    error: "Config write would flatten $include-owned config at plugins.load.paths.0",
  },
  {
    name: "rejects array shifts when an included value has a duplicate sibling",
    current: { plugins: { load: { paths: ["/same", "/same"] } } },
    authored: { plugins: { load: { paths: [{ $include: "./path.json5" }, "/same"] } } },
    next: { plugins: { load: { paths: ["/same"] } } },
    error: "Config write would flatten $include-owned config at plugins.load.paths.0",
  },
  {
    name: "allows unrelated removals after duplicate include-resolved values",
    current: { plugins: { load: { paths: ["/same", "/same", "/other"] } } },
    authored: {
      plugins: { load: { paths: [{ $include: "./path.json5" }, "/same", "/other"] } },
    },
    next: { plugins: { load: { paths: ["/same", "/same"] } } },
    expected: { plugins: { load: { paths: [{ $include: "./path.json5" }, "/same"] } } },
  },
  {
    name: "rejects included-entry removals hidden by duplicate sibling edits",
    current: { plugins: { load: { paths: ["/same", "/same", "/old"] } } },
    authored: {
      plugins: { load: { paths: [{ $include: "./path.json5" }, "/same", "/old"] } },
    },
    next: { plugins: { load: { paths: ["/same", "/new"] } } },
    error: "Config write would flatten $include-owned config at plugins.load.paths.0",
  },
  {
    name: "rejects newly introduced duplicates of include-owned array entries",
    current: { plugins: { load: { paths: ["/root", "/included"] } } },
    authored: { plugins: { load: { paths: ["/root", { $include: "./path.json5" }] } } },
    next: { plugins: { load: { paths: ["/included", "/included"] } } },
    error: "Config write would flatten $include-owned config at plugins.load.paths.1",
  },
  {
    name: "rejects writes that would flatten include-owned subtrees",
    current: { agents: { defaults: { model: "openai/gpt-5.4" } } },
    authored: { agents: { $include: "./config/agents.json" } },
    next: { agents: { defaults: { model: "anthropic/sonnet-4.5" } } },
    error: "Config write would flatten $include-owned config at agents",
  },
  {
    name: "preserves root $schema during unrelated partial writes",
    current: { $schema: "https://openclaw.ai/config.json", gateway: { mode: "local" } },
    next: { gateway: { mode: "local", port: 18789 } },
    expected: {
      $schema: "https://openclaw.ai/config.json",
      gateway: { mode: "local", port: 18789 },
    },
  },
  {
    name: "rejects writes that would flatten a root include",
    current: {
      $schema: "https://openclaw.ai/config-from-include.json",
      gateway: { mode: "local" },
    },
    authored: { $include: "./extra.json5", gateway: { mode: "local" } },
    next: { gateway: { mode: "local", port: 18789 } },
    error: "Config write would flatten $include-owned config at <root>",
  },
  {
    name: "does not restore root $schema when the next config explicitly clears it",
    current: { $schema: "https://openclaw.ai/config.json", gateway: { mode: "local" } },
    next: { $schema: null, gateway: { mode: "local", port: 18789 } },
    expected: { gateway: { mode: "local", port: 18789 } },
  },
  {
    name: "does not restore root $schema when the next config sets an invalid value",
    current: { $schema: "https://openclaw.ai/config.json", gateway: { mode: "local" } },
    next: { $schema: 123, gateway: { mode: "local", port: 18789 } },
    expected: { $schema: 123, gateway: { mode: "local", port: 18789 } },
  },
];

function resolveWriteCase(testCase: WriteCase): OpenClawConfig {
  return resolvePersistCandidateForWrite({
    runtimeConfig: testCase.current,
    sourceConfig: testCase.source ?? testCase.current,
    nextConfig: testCase.next,
    ...(testCase.authored === undefined ? {} : { rootAuthoredConfig: testCase.authored }),
    ...testCase.options,
  }) as OpenClawConfig;
}

describe("config io write prepare", () => {
  it.each(writeCases)("$name", (testCase) => {
    if (testCase.error) {
      expect(() => resolveWriteCase(testCase)).toThrow(testCase.error);
      return;
    }
    const persisted = resolveWriteCase(testCase);
    expect(persisted).toEqual(testCase.expected);
    testCase.verify?.(persisted);
  });

  it("ignores prototype-chain keys when building merge patches", () => {
    const base = { safe: { mode: "local" }, collision: { mode: "owned-base" } };
    const target = Object.create({ collision: { mode: "inherited-target" } }) as Record<
      string,
      unknown
    >;
    target.safe = { mode: "cloud" };
    expect(createMergePatch(base, target)).toEqual({
      safe: { mode: "cloud" },
      collision: null,
    });
  });

  it("strips transient plugin install records from partial writes", () => {
    const install = {
      source: "npm",
      spec: "@ollama/openclaw-web-search",
      installPath: "/tmp/openclaw-web-search",
      resolvedName: "@ollama/openclaw-web-search",
      resolvedVersion: "0.2.2",
    };
    const persisted = applyUnsetPathsForWrite(
      resolvePersistCandidateForWrite({
        runtimeConfig: { plugins: { entries: {} } },
        sourceConfig: { plugins: { entries: {}, installs: { "openclaw-web-search": install } } },
        nextConfig: {
          plugins: {
            entries: {},
            installs: {
              "openclaw-web-search": { ...install, spec: "@ollama/openclaw-web-search@0.2.2" },
            },
          },
        },
      }) as OpenClawConfig,
      [["plugins", "installs"]],
    );
    expect(persisted.plugins).not.toHaveProperty("installs");
  });

  it("preserves authored agent provider params during narrowed agent writes", () => {
    const defaults = {
      params: { transport: "sse", openaiWsWarmup: false },
      models: {
        "openai/gpt-5.4": {
          alias: "GPT",
          params: { transport: "sse", openaiWsWarmup: false },
        },
      },
    };
    const sourceConfig = {
      agents: { defaults, entries: { main: { default: true } } },
      gateway: { mode: "local" },
    };
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig: {
          ...sourceConfig,
          agents: { ...sourceConfig.agents, defaults: { ...defaults, maxConcurrent: 4 } },
        },
        sourceConfig,
        nextConfig: {
          agents: { entries: { main: { default: true }, ops: {} } },
          gateway: { mode: "local" },
        },
      }),
    ).toEqual({
      agents: { defaults, entries: { main: { default: true }, ops: {} } },
      gateway: { mode: "local" },
    });
  });

  it("preserves authored Google model params under normalized config keys", () => {
    const params = { thinking: { level: "high" } };
    const sourceConfig = {
      agents: {
        defaults: {
          model: { primary: "google/gemini-3-pro-preview" },
          models: { "google/gemini-3-pro-preview": { alias: "Gemini", params } },
        },
      },
    };
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig: sourceConfig,
        sourceConfig,
        nextConfig: {
          agents: {
            defaults: {
              model: { primary: "google/gemini-3.1-pro-preview" },
              models: { "google/gemini-3.1-pro-preview": {} },
            },
          },
        },
      }),
    ).toEqual({
      agents: {
        defaults: {
          model: { primary: "google/gemini-3.1-pro-preview" },
          models: { "google/gemini-3.1-pro-preview": { params } },
        },
      },
    });
  });

  it("normalizes retired Google model refs during unrelated config writes", () => {
    function makeGoogleConfig(modelRef: string): OpenClawConfig {
      return {
        agents: {
          defaults: {
            model: { primary: modelRef, fallbacks: [modelRef, "openai/gpt-5.5"] },
            utilityModel: modelRef,
            heartbeat: { model: modelRef },
            subagents: { model: { primary: modelRef, fallbacks: [modelRef] } },
            compaction: { model: modelRef, memoryFlush: { model: modelRef } },
            models: { [modelRef]: { alias: "Gemini" } },
          },
          entries: {
            ops: {
              model: { primary: modelRef, fallbacks: [modelRef] },
              utilityModel: modelRef,
              heartbeat: { model: modelRef },
              subagents: { model: modelRef },
              models: { [modelRef]: { alias: "Ops Gemini" } },
            },
          },
        },
        gateway: { port: 18789 },
      };
    }
    const runtimeConfig = makeGoogleConfig("google/gemini-3.1-pro-preview");
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig,
        sourceConfig: makeGoogleConfig("google/gemini-3-pro-preview"),
        nextConfig: { ...runtimeConfig, gateway: { port: 18888 } },
      }),
    ).toEqual({ ...runtimeConfig, gateway: { port: 18888 } });
  });

  it("normalizes retired Google provider catalog refs during unrelated config writes", () => {
    const makeModel = (id: string, name: string) => ({
      id,
      name,
      reasoning: true,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    });
    const makeConfig = (id: string): OpenClawConfig => ({
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [makeModel(id, "Gemini 3 Pro")],
          },
          kilocode: {
            baseUrl: "https://kilocode.test/v1",
            models: [makeModel(id, "Gemini via Kilo")],
          },
        },
      },
      gateway: { port: 18789 },
    });
    const runtimeConfig = makeConfig("google/gemini-3.1-pro-preview");
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig,
        sourceConfig: makeConfig("google/gemini-3-pro-preview"),
        nextConfig: { ...runtimeConfig, gateway: { port: 18888 } },
      }),
    ).toEqual({ ...runtimeConfig, gateway: { port: 18888 } });
  });

  it("normalizes manifest-backed provider catalog refs during unrelated config writes", () => {
    const makeModel = (id: string) => ({
      id,
      name: "Custom latest",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
    });
    const makeConfig = (id: string): OpenClawConfig => ({
      models: {
        providers: { myproxy: { baseUrl: "https://proxy.example/v1", models: [makeModel(id)] } },
      },
      gateway: { port: 18789 },
    });
    const runtimeConfig = makeConfig("vendor/modern-model");
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig,
        sourceConfig: makeConfig("latest"),
        nextConfig: { ...runtimeConfig, gateway: { port: 18888 } },
        modelIdNormalizationPolicies: new Map([
          ["myproxy", { aliases: { latest: "modern-model" }, prefixWhenBare: "vendor" }],
        ]),
      }),
    ).toEqual({ ...runtimeConfig, gateway: { port: 18888 } });
  });

  it("applies explicit unsets without mutating caller config", () => {
    const input: OpenClawConfig = {
      gateway: { mode: "local" },
      commands: { ownerDisplay: "hash" },
      tools: { alsoAllow: ["exec", "fetch", "read"] },
    };
    const before = structuredClone(input);
    expect(
      applyUnsetPathsForWrite(input, [
        ["commands", "ownerDisplay"],
        ["tools", "alsoAllow", "1"],
      ]),
    ).toEqual({ gateway: { mode: "local" }, tools: { alsoAllow: ["exec", "read"] } });
    expect(input).toEqual(before);
  });

  it.each([
    ["invalid array suffix", ["tools", "alsoAllow", "1abc"]],
    ["signed array index", ["tools", "alsoAllow", "+0"]],
    ["unsafe integer", ["tools", "alsoAllow", "9007199254740993"]],
    ["maximum array key", ["tools", "alsoAllow", "4294967294"]],
    ["missing key", ["commands", "missingKey"]],
    ["prototype key", ["commands", "__proto__"]],
    ["constructor key", ["commands", "constructor"]],
    ["prototype constructor property", ["commands", "prototype"]],
  ] as const)("treats %s unset paths as immutable no-ops", (_name, unsetPath) => {
    const input: OpenClawConfig = {
      gateway: { mode: "local" },
      commands: { ownerDisplay: "hash" },
      tools: { alsoAllow: ["exec", "fetch"] },
    };
    expect(applyUnsetPathsForWrite(input, [[...unsetPath]])).toBe(input);
  });

  it('formats actionable guidance for dmPolicy="open" without wildcard allowFrom', () => {
    const message = formatConfigValidationFailure(
      "channels.telegram.allowFrom",
      'channels.telegram.dmPolicy = "open" requires channels.telegram.allowFrom to include "*"',
    );
    expect(message).toContain("openclaw config set channels.telegram.allowFrom '[\"*\"]'");
    expect(message).toContain('openclaw config set channels.telegram.dmPolicy "pairing"');
  });

  it("preserves env refs on unchanged paths while keeping changed paths resolved", () => {
    const unchanged = {
      plugins: { entries: { acme: { config: { env: { API_KEY: "secret" } } } } },
    };
    const before = { ...unchanged, gateway: { port: 18789 } };
    const after = { ...unchanged, gateway: { port: 18789, auth: { mode: "token" } } };
    const changedPaths = new Set<string>();
    collectChangedPaths(before, after, "", changedPaths);
    expect(
      restoreEnvRefsFromMap(
        after,
        "",
        new Map([["plugins.entries.acme.config.env.API_KEY", "${ACME_API_KEY}"]]),
        changedPaths,
      ),
    ).toEqual({
      plugins: { entries: { acme: { config: { env: { API_KEY: "${ACME_API_KEY}" } } } } },
      gateway: { port: 18789, auth: { mode: "token" } },
    });
  });

  it("preserves env refs in arrays while keeping appended entries resolved", () => {
    const config = (args: string[]) => ({ plugins: { entries: { acme: { config: { args } } } } });
    const changedPaths = new Set<string>();
    collectChangedPaths(
      config(["${USER_ID}", "123"]),
      config(["${USER_ID}", "123", "456"]),
      "",
      changedPaths,
    );
    expect(
      restoreEnvRefsFromMap(
        config(["999", "123", "456"]),
        "",
        new Map([["plugins.entries.acme.config.args[0]", "${USER_ID}"]]),
        changedPaths,
      ),
    ).toEqual(config(["${USER_ID}", "123", "456"]));
  });

  it.each([
    {
      name: "does not overwrite identity-restored env refs with positional map entries",
      agents: [
        { id: "b", token: "${TOKEN_B}" },
        { id: "a", token: "${TOKEN_A}" },
      ],
      refs: [
        ["agents[0].token", "${TOKEN_A}"],
        ["agents[1].token", "${TOKEN_B}"],
      ] as const,
    },
    {
      name: "does not overwrite identity-restored escaped refs with positional map entries",
      agents: [
        { id: "real", token: "${TOKEN}" },
        { id: "literal", token: "$${TOKEN}" },
      ],
      refs: [["agents[1].token", "${TOKEN}"]] as const,
    },
  ])("$name", ({ agents, refs }) => {
    expect(
      restoreEnvRefsFromMap(
        { agents },
        "",
        new Map<string, string>(refs),
        new Set(["agents[0].id", "agents[1].id"]),
        new Set(["agents[0].token", "agents[1].token"]),
      ),
    ).toEqual({ agents });
  });

  it("ignores prototype-chain keys when collecting changed paths", () => {
    const base = { safe: { mode: "local" }, collision: { mode: "owned-base" } };
    const target = Object.create({ collision: { mode: "inherited-target" } }) as Record<
      string,
      unknown
    >;
    target.safe = { mode: "cloud" };
    const changedPaths = new Set<string>();
    collectChangedPaths(base, target, "", changedPaths);
    expect([...changedPaths].toSorted()).toEqual(["collision", "safe.mode"]);
  });

  it("restores unchanged paths even when their values equal another authored template", () => {
    expect(
      restoreEnvRefsFromMap(
        {
          included: {
            first: "${SECOND}",
            second: "second-secret",
            third: "$${SECOND}",
            escaped: "$${SECOND}",
          },
          gateway: { port: 18790 },
        },
        "",
        new Map([
          ["included.first", "${FIRST}"],
          ["included.second", "${SECOND}"],
          ["included.third", "${THIRD}"],
          ["included.escaped", "$${SECOND}"],
        ]),
        new Set(["gateway.port"]),
      ),
    ).toEqual({
      included: {
        first: "${FIRST}",
        second: "${SECOND}",
        third: "${THIRD}",
        escaped: "$${SECOND}",
      },
      gateway: { port: 18790 },
    });
  });

  it.each([
    {
      name: "keeps the read-time env snapshot when writing the same config path",
      expectedPath: "/tmp/openclaw.json",
      retained: true,
    },
    {
      name: "drops the read-time env snapshot when writing a different config path",
      expectedPath: "/tmp/other.json",
      retained: false,
    },
  ])("$name", ({ expectedPath, retained }) => {
    const snapshot = { OPENAI_API_KEY: "sk-secret" };
    const actual = resolveWriteEnvSnapshotForPath({
      actualConfigPath: "/tmp/openclaw.json",
      expectedConfigPath: expectedPath,
      envSnapshotForRestore: snapshot,
    });
    if (retained) {
      expect(actual).toBe(snapshot);
    } else {
      expect(actual).toBeUndefined();
    }
  });

  it("keeps runtime-only channel defaults out of the persisted candidate", () => {
    const sourceConfig = {
      gateway: { port: 18789 },
      channels: { imessage: { cliPath: "/usr/local/bin/imsg" } },
    };
    const runtimeConfig = {
      ...sourceConfig,
      channels: { imessage: { cliPath: "/usr/local/bin/imsg", runtimeOnlyDefault: true } },
    };
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig,
        sourceConfig,
        nextConfig: {
          ...structuredClone(runtimeConfig),
          gateway: { port: 18789, auth: { mode: "token" } },
        },
      }),
    ).toEqual({
      gateway: { port: 18789, auth: { mode: "token" } },
      channels: { imessage: { cliPath: "/usr/local/bin/imsg" } },
    });
  });

  it("does not reintroduce legacy nested dm.policy defaults in the persisted candidate", () => {
    const oldChannel = { dmPolicy: "pairing", dm: { enabled: true, policy: "pairing" } };
    const newChannel = { dmPolicy: "pairing", dm: { enabled: true } };
    const sourceConfig = {
      channels: { discord: structuredClone(oldChannel), slack: structuredClone(oldChannel) },
      gateway: { port: 18789 },
    };
    const nextConfig = {
      channels: { discord: structuredClone(newChannel), slack: structuredClone(newChannel) },
      gateway: { port: 18789 },
    };
    expect(
      resolvePersistCandidateForWrite({ runtimeConfig: sourceConfig, sourceConfig, nextConfig }),
    ).toEqual(nextConfig);
  });

  it("preserves normalized nested channel enabled keys during unrelated writes", () => {
    const channels = {
      slack: { channels: { ops: { enabled: false } } },
      googlechat: { groups: { "spaces/aaa": { enabled: true } } },
      discord: { guilds: { "100": { channels: { general: { enabled: false } } } } },
    };
    const sourceConfig = { channels };
    const nextConfig = { ...structuredClone(sourceConfig), gateway: { auth: { mode: "token" } } };
    expect(
      resolvePersistCandidateForWrite({ runtimeConfig: sourceConfig, sourceConfig, nextConfig }),
    ).toEqual(nextConfig);
  });

  it.each([
    {
      name: "allows an explicit local leaf override beside a root include",
      authored: { $include: "./agents.json5" },
      expected: {
        $include: "./agents.json5",
        agents: { defaults: { workspace: "/srv/next" } },
      },
    },
    {
      name: "allows an explicit local leaf override below a nested include",
      authored: { agents: { $include: "./agents.json5" } },
      expected: {
        agents: { $include: "./agents.json5", defaults: { workspace: "/srv/next" } },
      },
    },
  ])("$name", ({ authored, expected }) => {
    const sourceConfig = {
      agents: { defaults: { workspace: "/srv/old" }, entries: { ops: main } },
    };
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig: sourceConfig,
        sourceConfig,
        rootAuthoredConfig: authored,
        nextConfig: sourceConfig,
        explicitSetPaths: [["agents", "defaults", "workspace"]],
        explicitSetValueSource: { agents: { defaults: { workspace: "/srv/next" } } },
        allowIncludeAncestorExplicitSetPaths: true,
      }),
    ).toEqual(expected);
  });

  it.each([
    {
      name: "persists explicitly set keys whose values match runtime defaults",
      paths: [
        ["channels", "telegram", "dmPolicy"],
        ["channels", "telegram", "groupPolicy"],
      ],
    },
    {
      name: "persists default-valued children inside explicitly set objects",
      paths: [["channels", "telegram"]],
    },
  ])("$name", ({ paths }) => {
    const telegram = { botToken: "tok-abc", dmPolicy: "pairing", groupPolicy: "allowlist" };
    const runtimeConfig = { channels: { telegram } };
    const sourceConfig = { channels: { telegram: { botToken: "tok-abc" } } };
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig,
        sourceConfig,
        nextConfig: sourceConfig,
        explicitSetValueSource: runtimeConfig,
        explicitSetPaths: paths,
      }),
    ).toEqual(runtimeConfig);
  });

  it.each([
    {
      name: "persists explicitly set array-index children whose values match runtime defaults",
      paths: [["models", "providers", "openai", "models", "0", "contextWindow"]],
      includesDefault: true,
    },
    {
      name: "ignores unsafe array-index explicit set paths",
      paths: [
        ["models", "providers", "openai", "models", "0abc", "contextWindow"],
        ["models", "providers", "openai", "models", "+0", "contextWindow"],
        ["models", "providers", "openai", "models", "9007199254740993", "contextWindow"],
        ["models", "providers", "openai", "models", "4294967294", "contextWindow"],
      ],
      includesDefault: false,
    },
  ])("$name", ({ paths, includesDefault }) => {
    const withModels = (models: Record<string, unknown>[]) => ({
      models: { providers: { openai: { models } } },
    });
    const sourceConfig = withModels([{ id: "gpt-5.5" }]);
    const runtimeConfig = withModels([{ id: "gpt-5.5", contextWindow: 128000 }]);
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig,
        sourceConfig,
        nextConfig: sourceConfig,
        explicitSetValueSource: runtimeConfig,
        explicitSetPaths: paths,
      }),
    ).toEqual(includesDefault ? runtimeConfig : sourceConfig);
  });

  it("rejects default-valued explicit writes under include-owned paths", () => {
    const sourceConfig = { agents: { defaults: {} } };
    expect(() =>
      resolvePersistCandidateForWrite({
        runtimeConfig: { agents: { defaults: { params: { temperature: 0 } } } },
        sourceConfig,
        rootAuthoredConfig: { agents: { defaults: { $include: "./agents-defaults.json" } } },
        nextConfig: sourceConfig,
        explicitSetValueSource: { agents: { defaults: { params: { temperature: 0 } } } },
        explicitSetPaths: [["agents", "defaults", "params"]],
      }),
    ).toThrow("Config write would flatten $include-owned config at agents.defaults");
  });
});
