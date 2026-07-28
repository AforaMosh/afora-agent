import { describe, expect, it } from "vitest";
import { createConfigMutationOperations } from "./config-path-mutation.js";
import { prepareConfigWrite } from "./io.write-plan.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

function snapshot(
  params: {
    parsed?: unknown;
    sourceConfig?: OpenClawConfig;
    runtimeConfig?: OpenClawConfig;
    includeProvenance?: ConfigFileSnapshot["includeProvenance"];
  } = {},
) {
  const parsed = params.parsed ?? {};
  const sourceConfig = params.sourceConfig ?? (parsed as OpenClawConfig);
  return {
    path: "/tmp/openclaw.json",
    parsed,
    sourceConfig,
    runtimeConfig: params.runtimeConfig ?? sourceConfig,
    includeProvenance: params.includeProvenance,
    valid: true,
  } satisfies Pick<
    ConfigFileSnapshot,
    "path" | "parsed" | "sourceConfig" | "runtimeConfig" | "includeProvenance" | "valid"
  >;
}

describe("prepareConfigWrite", () => {
  it("applies source operations without leaking runtime defaults or changing untouched syntax", () => {
    const current = snapshot({
      parsed: {
        $schema: "https://openclaw.ai/config.schema.json",
        agents: { defaults: { workspace: "${WORKSPACE}" } },
      },
      sourceConfig: { agents: { defaults: { workspace: "/srv/workspace" } } },
      runtimeConfig: {
        agents: { defaults: { workspace: "/srv/workspace" } },
        gateway: { port: 18789 },
        messages: { ackReaction: "eyes" },
      },
    });

    const result = prepareConfigWrite({
      snapshot: current,
      intent: {
        kind: "mutate",
        operations: [{ kind: "set", path: ["gateway", "mode"], value: "local" }],
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        authoredDocument: {
          $schema: "https://openclaw.ai/config.schema.json",
          agents: { defaults: { workspace: "${WORKSPACE}" } },
          gateway: { mode: "local" },
        },
        changedPaths: ["gateway"],
      },
    });
  });

  it("keeps an absent roster as the source-level implicit-main default", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { gateway: { mode: "local" } },
        runtimeConfig: {
          gateway: { mode: "local" },
          agents: { entries: { main: { default: true } } },
        },
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "set", path: ["gateway", "port"], value: 19001 }],
      },
    });

    expect(result.ok && result.value.authoredDocument).toEqual({
      gateway: { mode: "local", port: 19001 },
    });
  });

  it("authors implicit main when a mutation first materializes the roster", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { gateway: { mode: "local" } },
        runtimeConfig: {
          gateway: { mode: "local" },
          agents: { entries: { main: { default: true } } },
        },
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "set", path: ["agents", "entries", "ops"], value: {} }],
      },
    });

    expect(result.ok && result.value.authoredDocument.agents?.entries).toEqual({
      main: { default: true },
      ops: {},
    });
  });

  it("keeps implicit main default when a mutation first edits that entry", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { gateway: { mode: "local" } },
        runtimeConfig: {
          gateway: { mode: "local" },
          agents: { entries: { main: { default: true } } },
        },
      }),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "set",
            path: ["agents", "entries", "main", "workspace"],
            value: "/srv/main",
          },
        ],
      },
    });

    expect(result.ok && result.value.authoredDocument.agents?.entries).toEqual({
      main: { default: true, workspace: "/srv/main" },
    });
  });

  it("does not add a default marker to a pre-existing authored main entry", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: {
          agents: {
            entries: {
              main: { workspace: "/srv/main" },
              ops: { default: true },
            },
          },
        },
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "set", path: ["gateway", "mode"], value: "local" }],
      },
    });

    expect(result.ok && result.value.authoredDocument.agents?.entries).toEqual({
      main: { workspace: "/srv/main" },
      ops: { default: true },
    });
  });

  it("honors an explicit removal of runtime-only implicit main", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        runtimeConfig: { agents: { entries: { main: { default: true } } } },
      }),
      intent: {
        kind: "mutate",
        operations: [
          { kind: "set", path: ["agents", "entries", "ops"], value: { default: true } },
          { kind: "unset", path: ["agents", "entries", "main"] },
        ],
      },
    });
    expect(result.ok && result.value.authoredDocument.agents?.entries).toEqual({
      ops: { default: true },
    });
  });

  it("distinguishes numeric map keys from array indexes in changed paths", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: {
          agents: { entries: { "10": { identity: { name: "old" } } } },
          plugins: { allow: ["old"] },
        },
      }),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "set",
            path: ["agents", "entries", "10", "identity", "name"],
            value: "new",
          },
          { kind: "set", path: ["plugins", "allow", "0"], value: "new" },
        ],
      },
    });

    expect(result.ok && result.value.changedPaths).toEqual([
      "agents.entries.10.identity.name",
      "plugins.allow[0]",
    ]);
  });

  it("rejects implicit keyed-agent removal and accepts an explicit unset", () => {
    const current = snapshot({
      parsed: {
        agents: { entries: { main: { default: true }, ops: { workspace: "/srv/ops" } } },
      },
    });

    expect(
      prepareConfigWrite({
        snapshot: current,
        intent: {
          kind: "mutate",
          operations: [
            { kind: "set", path: ["agents", "entries"], value: { main: { default: true } } },
          ],
        },
      }),
    ).toEqual({ ok: false, error: { code: "implicit-agent-removal", agentIds: ["ops"] } });

    const explicit = prepareConfigWrite({
      snapshot: current,
      intent: {
        kind: "mutate",
        operations: createConfigMutationOperations(current.parsed, {
          agents: { entries: { main: { default: true } } },
        }),
      },
    });
    expect(explicit.ok && explicit.value.authoredDocument).toEqual({
      agents: { entries: { main: { default: true } } },
    });

    expect(
      prepareConfigWrite({
        snapshot: current,
        intent: {
          kind: "mutate",
          operations: [
            { kind: "set", path: ["agents", "entries"], value: { main: { default: true } } },
            { kind: "unset", path: [] },
          ],
        },
      }),
    ).toEqual({ ok: false, error: { code: "implicit-agent-removal", agentIds: ["ops"] } });
  });

  it("accepts explicit parent removal through a merge patch", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { agents: { entries: { main: { default: true }, ops: {} } } },
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "merge", patch: { agents: null } }],
      },
    });
    expect(result.ok && result.value.authoredDocument).toEqual({});
  });

  it("rejects writes that overlap include ownership", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { gateway: { $include: "./gateway.json5" } },
        sourceConfig: { gateway: { mode: "local", port: 18789 } },
        includeProvenance: [
          {
            path: ["gateway"],
            contributedPaths: [
              ["gateway", "mode"],
              ["gateway", "port"],
            ],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/gateway.json5",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "set", path: ["gateway", "port"], value: 19001 }],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "include-owned",
        path: ["gateway"],
        filePath: "/tmp/gateway.json5",
      },
    });
  });

  it("allows mutations outside a nested include boundary", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { gateway: { $include: "./gateway.json5" } },
        sourceConfig: { gateway: { mode: "local" } },
        includeProvenance: [
          {
            path: ["gateway"],
            contributedPaths: [["gateway", "mode"]],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/gateway.json5",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "set", path: ["logging", "level"], value: "debug" }],
      },
    });

    expect(result.ok && result.value.authoredDocument).toEqual({
      gateway: { $include: "./gateway.json5" },
      logging: { level: "debug" },
    });
  });

  it("allows an empty root merge patch when the config contains an include", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { gateway: { $include: "./gateway.json5" } },
        sourceConfig: { gateway: { mode: "local" } },
        includeProvenance: [
          {
            path: ["gateway"],
            contributedPaths: [["gateway", "mode"]],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/gateway.json5",
          },
        ],
      }),
      intent: { kind: "mutate", operations: [{ kind: "merge", patch: {} }] },
    });

    expect(result.ok && result.value.authoredDocument).toEqual({
      gateway: { $include: "./gateway.json5" },
    });
  });

  it("rejects structural edits to an array that contains an include", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { plugins: { load: { paths: ["local", { $include: "./path.json5" }] } } },
        sourceConfig: { plugins: { load: { paths: ["local", "/included"] } } },
        includeProvenance: [
          {
            path: ["plugins", "load", "paths", "1"],
            contributedPaths: [["plugins", "load", "paths", "1"]],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/path.json5",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [
          { kind: "unset", path: ["plugins", "load", "paths", "0"] },
          { kind: "unset", path: ["plugins", "load", "paths", "0"] },
        ],
      },
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "include-owned",
        path: ["plugins", "load", "paths", "1"],
        filePath: "/tmp/path.json5",
      },
    });
  });

  it("checks include ownership for array-container coercions", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { foo: { owned: { $include: "./owned.json5" } } },
        includeProvenance: [
          {
            path: ["foo", "owned"],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/owned.json5",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "set",
            path: ["foo", "0"],
            value: "replacement",
            arrayContainerDepths: [1],
          },
        ],
      },
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "include-owned",
        path: ["foo", "owned"],
        filePath: "/tmp/owned.json5",
      },
    });
  });

  it("allows editing a sibling slot in an existing include-bearing array", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { foo: [{ $include: "./owned.json5" }, "local"] },
        includeProvenance: [
          {
            path: ["foo", "0"],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/owned.json5",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "set",
            path: ["foo", "1"],
            value: "updated",
            arrayContainerDepths: [1],
          },
        ],
      },
    });
    expect(result.ok && (result.value.authoredDocument as { foo?: unknown[] }).foo).toEqual([
      { $include: "./owned.json5" },
      "updated",
    ]);
  });

  it("does not treat numeric map keys as array indexes", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: {
          agents: { entries: { "10": {}, "11": { $include: "./agent.json5" } } },
        },
        includeProvenance: [
          {
            path: ["agents", "entries", "11"],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/agent.json5",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "unset", path: ["agents", "entries", "10"] }],
      },
    });
    expect(result.ok && result.value.authoredDocument.agents?.entries).toEqual({
      "11": { $include: "./agent.json5" },
    });
  });

  it("rejects root includes and include sibling overrides", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { $include: "./base.json5", gateway: { port: 19001 } },
        sourceConfig: { gateway: { mode: "local", port: 19001 } },
        includeProvenance: [
          {
            path: [],
            contributedPaths: [["gateway", "mode"]],
            kind: "single",
            hasSiblingOverrides: true,
            targetPath: "/tmp/base.json5",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "set", path: ["gateway", "port"], value: 19002 }],
      },
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "include-owned", path: [], filePath: "/tmp/base.json5" },
    });
  });

  it("rejects blocked keys nested inside an intent-owned value", () => {
    const unsafeValue = JSON.parse('{"safe":true,"__proto__":{"polluted":true}}');
    const result = prepareConfigWrite({
      snapshot: snapshot(),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "set",
            path: ["plugins", "entries", "demo", "config"],
            value: unsafeValue,
          },
        ],
      },
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "blocked-key",
        path: ["plugins", "entries", "demo", "config", "__proto__"],
      },
    });
  });

  it("checks mandatory unsets against include ownership", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { plugins: { installs: { $include: "./installs.json" } } },
        sourceConfig: { plugins: { installs: { demo: { source: "npm" } } } },
        includeProvenance: [
          {
            path: ["plugins", "installs"],
            contributedPaths: [["plugins", "installs", "demo"]],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/installs.json",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "set", path: ["gateway", "mode"], value: "local" }],
      },
      mandatoryUnsets: [["plugins", "installs"]],
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "include-owned",
        path: ["plugins", "installs"],
        filePath: "/tmp/installs.json",
      },
    });
  });

  it("does not normalize unrelated retired model refs and removes managed install metadata", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: {
          agents: { defaults: { model: "openai-codex/gpt-5.2" } },
          plugins: { installs: { demo: { source: "npm" } } },
        },
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "set", path: ["gateway", "mode"], value: "local" }],
      },
      mandatoryUnsets: [["plugins", "installs"]],
    });
    expect(result.ok && result.value.authoredDocument).toEqual({
      agents: { defaults: { model: "openai-codex/gpt-5.2" } },
      gateway: { mode: "local" },
    });
  });

  it("removes managed metadata introduced by the same intent", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot(),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "set",
            path: ["plugins", "installs", "demo"],
            value: { source: "npm" },
          },
        ],
      },
      mandatoryUnsets: [["plugins", "installs"]],
    });
    expect(result.ok && result.value.authoredDocument).toEqual({});
  });
});
