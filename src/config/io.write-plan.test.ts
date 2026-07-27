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
    });
    current.runtimeConfig = {
      ...current.sourceConfig,
      gateway: { port: 18789 },
      messages: { ackReaction: "eyes" },
    };

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

  it("keeps the absent roster source default during unrelated mutations", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({ parsed: { gateway: { mode: "local" } } }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "set", path: ["gateway", "port"], value: 19001 }],
      },
    });

    expect(result.ok && result.value.authoredDocument).toEqual({
      gateway: { mode: "local", port: 19001 },
    });
  });

  it("authors implicit main when a mutation first materializes agent entries", () => {
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

    expect(result).toEqual({
      ok: true,
      value: {
        authoredDocument: {
          gateway: { mode: "local" },
          agents: { entries: { main: { default: true }, ops: {} } },
        },
        changedPaths: ["agents"],
      },
    });
  });

  it("moves the default marker when the first named agent is explicitly default", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        runtimeConfig: { agents: { entries: { main: { default: true } } } },
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "set", path: ["agents", "entries", "ops"], value: { default: true } }],
      },
    });

    expect(result.ok && result.value.authoredDocument.agents?.entries).toEqual({
      main: {},
      ops: { default: true },
    });
  });

  it("retains the implicit default when the first roster mutation targets main", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        runtimeConfig: { agents: { entries: { main: { default: true } } } },
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

  it("does not restore implicit main after its authorized removal", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        runtimeConfig: { agents: { entries: { main: { default: true } } } },
      }),
      intent: {
        kind: "mutate",
        allowAgentRosterRemovals: ["main"],
        operations: [
          {
            kind: "set",
            path: ["agents", "entries"],
            value: { ops: { default: true } },
          },
          { kind: "unset", path: ["agents", "entries", "main"] },
        ],
      },
    });

    expect(result.ok && result.value.authoredDocument.agents?.entries).toEqual({
      ops: { default: true },
    });
  });

  it("does not treat main-removal authorization as a deletion request", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        runtimeConfig: { agents: { entries: { main: { default: true } } } },
      }),
      intent: {
        kind: "mutate",
        allowAgentRosterRemovals: ["main"],
        operations: [{ kind: "set", path: ["agents", "entries", "ops"], value: {} }],
      },
    });

    expect(result.ok && result.value.authoredDocument.agents?.entries).toEqual({
      main: { default: true },
      ops: {},
    });
  });

  it("distinguishes numeric map keys from array indexes in changed paths", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: {
          agents: {
            entries: {
              "10": { identity: { name: "old" } },
            },
          },
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

  it("rejects implicit keyed-agent removal but accepts explicit deletion", () => {
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

    expect(
      prepareConfigWrite({
        snapshot: current,
        intent: {
          kind: "mutate",
          operations: createConfigMutationOperations(current.parsed, {
            agents: { entries: { main: { default: true } } },
          }),
        },
      }),
    ).toEqual({ ok: false, error: { code: "implicit-agent-removal", agentIds: ["ops"] } });

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

    const explicit = prepareConfigWrite({
      snapshot: current,
      intent: {
        kind: "mutate",
        allowAgentRosterRemovals: ["ops"],
        operations: [{ kind: "unset", path: ["agents", "entries", "ops"] }],
      },
    });
    expect(explicit.ok && explicit.value.authoredDocument).toEqual({
      agents: { entries: { main: { default: true } } },
    });

    const explicitParentDelete = prepareConfigWrite({
      snapshot: current,
      intent: {
        kind: "mutate",
        allowAgentRosterRemovals: ["main", "ops"],
        operations: [{ kind: "merge", patch: { agents: null } }],
      },
    });
    expect(explicitParentDelete.ok && explicitParentDelete.value.authoredDocument).toEqual({});
  });

  it("retains normalized agent identity across key spelling changes", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { agents: { entries: { Ops: { default: true } } } },
      }),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "set",
            path: ["agents", "entries"],
            value: { ops: { default: true } },
          },
        ],
      },
    });

    expect(result.ok && result.value.authoredDocument.agents?.entries).toEqual({
      ops: { default: true },
    });
  });

  it("rejects replacing an include-owned boundary and names the owning file", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { agents: { $include: "./agents.json" } },
        sourceConfig: { agents: { entries: { main: { default: true } } } },
        includeProvenance: [
          {
            path: ["agents"],
            kind: "single",
            hasSiblingOverrides: true,
            targetPath: "/tmp/agents.json",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "set",
            path: ["agents"],
            value: { entries: { main: { default: true } } },
          },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "include-owned", path: ["agents"], filePath: "/tmp/agents.json" },
    });
  });

  it("treats an empty nested merge patch as owning its path", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { agents: { $include: "./agents.json" } },
        sourceConfig: { agents: { entries: { main: { default: true } } } },
        includeProvenance: [
          {
            path: ["agents"],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/agents.json",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "merge", patch: { agents: {} } }],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "include-owned", path: ["agents"], filePath: "/tmp/agents.json" },
    });
  });

  it("rejects unsetting a value inherited solely from an include", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { $include: "./base.json" },
        sourceConfig: { gateway: { mode: "local" } },
        includeProvenance: [
          {
            path: [],
            contributedPaths: [["gateway", "mode"]],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/base.json",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "unset", path: ["gateway", "mode"] }],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "include-owned", path: [], filePath: "/tmp/base.json" },
    });
  });

  it("allows unsetting a locally authored include sibling", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { $include: "./base.json", gateway: { mode: "local" } },
        sourceConfig: { gateway: { mode: "local" } },
        includeProvenance: [
          {
            path: [],
            contributedPaths: [["gateway", "mode"]],
            kind: "single",
            hasSiblingOverrides: true,
            targetPath: "/tmp/base.json",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "unset", path: ["gateway", "mode"] }],
      },
    });

    expect(result.ok && result.value.authoredDocument).toEqual({ $include: "./base.json" });
  });

  it("rejects a strict unset that would reveal an include-provided agent", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: {
          $include: "./base.json",
          agents: { entries: { ops: { workspace: "/srv/local" } } },
        },
        sourceConfig: { agents: { entries: { ops: { workspace: "/srv/local" } } } },
        includeProvenance: [
          {
            path: [],
            contributedPaths: [["agents", "entries", "ops"]],
            kind: "single",
            hasSiblingOverrides: true,
            targetPath: "/tmp/base.json",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "unset",
            path: ["agents", "entries", "ops"],
            strictIncludeOwnership: true,
          },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "include-owned", path: [], filePath: "/tmp/base.json" },
    });
  });

  it("reports the most specific nested include owner", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { $include: "./base.json" },
        sourceConfig: { agents: { entries: { ops: { workspace: "/srv/ops" } } } },
        includeProvenance: [
          {
            path: ["agents", "entries"],
            contributedPaths: [["agents", "entries", "ops"]],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/agents.json",
          },
          {
            path: [],
            contributedPaths: [["agents", "entries", "ops"]],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/base.json",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "unset",
            path: ["agents", "entries", "ops"],
            strictIncludeOwnership: true,
          },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "include-owned",
        path: ["agents", "entries"],
        filePath: "/tmp/agents.json",
      },
    });
  });

  it("allows an explicit null override below an ancestor include", () => {
    const sourceConfig = {
      plugins: { entries: { demo: { config: { mode: "auto" } } } },
    };
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { $include: "./base.json" },
        sourceConfig,
        includeProvenance: [
          {
            path: [],
            contributedPaths: [["plugins", "entries", "demo", "config", "mode"]],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/base.json",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: createConfigMutationOperations(sourceConfig, {
          plugins: { entries: { demo: { config: { mode: null } } } },
        }),
      },
    });

    expect(result.ok && result.value.authoredDocument).toEqual({
      $include: "./base.json",
      plugins: { entries: { demo: { config: { mode: null } } } },
    });
  });

  it("rejects converting an include-owned array for an indexed set", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { plugins: { allow: { $include: "./allow.json" } } },
        sourceConfig: { plugins: { allow: ["existing"] } },
        includeProvenance: [
          {
            path: ["plugins", "allow"],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/allow.json",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "set",
            path: ["plugins", "allow", "0"],
            value: "replacement",
          },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "include-owned",
        path: ["plugins", "allow"],
        filePath: "/tmp/allow.json",
      },
    });
  });

  it("rejects an indexed set when an ancestor include supplies the array", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { $include: "./base.json" },
        sourceConfig: { plugins: { allow: ["existing", "other"] } },
        includeProvenance: [
          {
            path: [],
            contributedPaths: [["plugins", "allow"]],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/base.json",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "set",
            path: ["plugins", "allow", "0"],
            value: "replacement",
          },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "include-owned", path: [], filePath: "/tmp/base.json" },
    });
  });

  it("tracks include ownership across sequential array removals", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: {
          plugins: { load: { paths: ["/local", { $include: "./path.json5" }] } },
        },
        sourceConfig: { plugins: { load: { paths: ["/local", "/included"] } } },
        includeProvenance: [
          {
            path: ["plugins", "load", "paths", "1"],
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
        path: ["plugins", "load", "paths", "0"],
        filePath: "/tmp/path.json5",
      },
    });
  });

  it("retains provenance after editing a sibling in an included array element", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: {
          plugins: {
            load: { paths: [{ value: { $include: "./value.json5" }, enabled: true }] },
          },
        },
        sourceConfig: {
          plugins: { load: { paths: [{ value: "/included", enabled: true }] } },
        },
        includeProvenance: [
          {
            path: ["plugins", "load", "paths", "0", "value"],
            kind: "single",
            hasSiblingOverrides: true,
            targetPath: "/tmp/value.json5",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "set",
            path: ["plugins", "load", "paths", "0", "enabled"],
            value: false,
          },
          { kind: "unset", path: ["plugins", "load", "paths", "0", "value"] },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "include-owned",
        path: ["plugins", "load", "paths", "0", "value"],
        filePath: "/tmp/value.json5",
      },
    });
  });

  it("remaps nested include provenance through a stable outer array index", () => {
    const includeNode = { $include: "./value.json5" };
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { plugins: { load: { entries: [{ items: [includeNode, "local"] }] } } },
        sourceConfig: { plugins: { load: { entries: [{ items: ["from-include", "local"] }] } } },
        includeProvenance: [
          {
            path: ["plugins", "load", "entries", "0", "items", "0"],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/value.json5",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "set",
            path: ["plugins", "load", "entries", "0", "items"],
            value: ["local", includeNode],
          },
          {
            kind: "unset",
            path: ["plugins", "load", "entries", "0", "items", "1"],
          },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "include-owned",
        path: ["plugins", "load", "entries", "0", "items", "1"],
        filePath: "/tmp/value.json5",
      },
    });
  });

  it("remaps provenance when an edited include-bearing element moves", () => {
    const includeNode = { $include: "./value.json5" };
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: {
          plugins: {
            load: { entries: [{ value: includeNode, enabled: true }, "local"] },
          },
        },
        sourceConfig: {
          plugins: {
            load: { entries: [{ value: "from-include", enabled: true }, "local"] },
          },
        },
        includeProvenance: [
          {
            path: ["plugins", "load", "entries", "0", "value"],
            kind: "single",
            hasSiblingOverrides: true,
            targetPath: "/tmp/value.json5",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "set",
            path: ["plugins", "load", "entries"],
            value: ["local", { value: includeNode, enabled: false }],
          },
          { kind: "unset", path: ["plugins", "load", "entries", "1"] },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "include-owned",
        path: ["plugins", "load", "entries", "1", "value"],
        filePath: "/tmp/value.json5",
      },
    });
  });

  it("rejects a whole-array override when the array exists only through an include", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { $include: "./base.json" },
        sourceConfig: { plugins: { load: { paths: ["/included"] } } },
        includeProvenance: [
          {
            path: [],
            contributedPaths: [["plugins", "load", "paths"]],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/base.json",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [
          { kind: "merge", patch: { plugins: { load: { paths: ["/included", "/new"] } } } },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "include-owned", path: [], filePath: "/tmp/base.json" },
    });
  });

  it("checks include-owned arrays nested inside an object-valued set", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { $include: "./base.json" },
        sourceConfig: { plugins: { allow: ["a", "b"] } },
        includeProvenance: [
          {
            path: [],
            contributedPaths: [["plugins", "allow"]],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/base.json",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "set", path: ["plugins"], value: { allow: ["x"] } }],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "include-owned", path: [], filePath: "/tmp/base.json" },
    });
  });

  it("rejects an object set that omits an include-contributed child", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { $include: "./base.json" },
        sourceConfig: { gateway: { auth: { mode: "token", token: "test-token" } } },
        includeProvenance: [
          {
            path: [],
            contributedPaths: [["gateway", "auth", "token"]],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/base.json",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "set", path: ["gateway", "auth"], value: { mode: "none" } }],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "include-owned", path: [], filePath: "/tmp/base.json" },
    });
  });

  it("allows a whole-array edit that uniquely retains its authored include node", () => {
    const includeNode = { $include: "./path.json5" };
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { plugins: { load: { paths: [includeNode, "/local"] } } },
        sourceConfig: { plugins: { load: { paths: ["/included", "/local"] } } },
        includeProvenance: [
          {
            path: ["plugins", "load", "paths", "0"],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/path.json5",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [
          {
            kind: "merge",
            patch: { plugins: { load: { paths: [includeNode, "/local", "/new"] } } },
          },
        ],
      },
    });

    expect(result.ok && result.value.authoredDocument).toEqual({
      plugins: { load: { paths: [includeNode, "/local", "/new"] } },
    });
  });

  it("rejects reducing duplicate authored include nodes", () => {
    const includeNode = { $include: "./path.json5" };
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { plugins: { load: { paths: [includeNode, includeNode] } } },
        sourceConfig: { plugins: { load: { paths: ["first", "second"] } } },
        includeProvenance: [
          {
            path: ["plugins", "load", "paths", "0"],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/path.json5",
          },
          {
            path: ["plugins", "load", "paths", "1"],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/path.json5",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "set", path: ["plugins", "load", "paths"], value: [includeNode] }],
      },
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("include-owned");
  });

  it("allows an explicit local deletion to reveal an included fallback", () => {
    const sourceConfig = { gateway: { mode: "local" as const } };
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { $include: "./base.json", gateway: { mode: "local" } },
        sourceConfig,
        includeProvenance: [
          {
            path: [],
            contributedPaths: [["gateway", "mode"]],
            kind: "single",
            hasSiblingOverrides: true,
            targetPath: "/tmp/base.json",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: createConfigMutationOperations(sourceConfig, {}, { strictDeletions: false }),
      },
    });

    expect(result.ok && result.value.authoredDocument).toEqual({ $include: "./base.json" });
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

  it("does not attribute an unrelated contributed sibling to a mandatory unset", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: { $include: "./plugins.json" },
        sourceConfig: { plugins: { entries: { demo: { enabled: true } } } },
        includeProvenance: [
          {
            path: [],
            contributedPaths: [["plugins"], ["plugins", "entries", "demo"]],
            kind: "single",
            hasSiblingOverrides: false,
            targetPath: "/tmp/plugins.json",
          },
        ],
      }),
      intent: {
        kind: "mutate",
        operations: [{ kind: "set", path: ["gateway", "mode"], value: "local" }],
      },
      mandatoryUnsets: [["plugins", "installs"]],
    });

    expect(result.ok && result.value.authoredDocument).toEqual({
      $include: "./plugins.json",
      gateway: { mode: "local" },
    });
  });

  it("rejects a mandatory unset that would reveal an included fallback", () => {
    const result = prepareConfigWrite({
      snapshot: snapshot({
        parsed: {
          $include: "./base.json",
          plugins: { installs: { local: { source: "npm" } } },
        },
        sourceConfig: {
          plugins: {
            installs: {
              included: { source: "npm" },
              local: { source: "npm" },
            },
          },
        },
        includeProvenance: [
          {
            path: [],
            contributedPaths: [["plugins", "installs", "included"]],
            kind: "single",
            hasSiblingOverrides: true,
            targetPath: "/tmp/base.json",
          },
        ],
      }),
      intent: { kind: "mutate", operations: [] },
      mandatoryUnsets: [["plugins", "installs"]],
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "include-owned", path: [], filePath: "/tmp/base.json" },
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
});
