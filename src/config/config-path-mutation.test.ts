import { describe, expect, it } from "vitest";
import {
  applyConfigOperations,
  createConfigMutationOperations,
  createRuntimeConfigMutationOperations,
  projectExplicitRuntimeValueOntoAuthored,
} from "./config-path-mutation.js";
import { collectSensitiveIncludeSourcePaths } from "./include-sensitivity.js";

describe("applyConfigOperations", () => {
  it("keeps sensitivity only from the winning include contribution", () => {
    expect(
      collectSensitiveIncludeSourcePaths({
        includeProvenance: [
          {
            path: ["plugins"],
            kind: "single",
            hasSiblingOverrides: false,
            terminalContributedPaths: [["plugins", "mode"]],
            sensitiveContributedPaths: [["plugins", "mode"]],
          },
          {
            path: ["plugins"],
            kind: "single",
            hasSiblingOverrides: true,
            terminalContributedPaths: [["plugins", "mode"]],
            sensitiveContributedPaths: [],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("keeps sensitive descendants inside included arrays", () => {
    expect(
      collectSensitiveIncludeSourcePaths({
        includeProvenance: [
          {
            path: ["accounts"],
            kind: "single",
            hasSiblingOverrides: false,
            terminalContributedPaths: [["accounts"]],
            sensitiveContributedPaths: [["accounts", "0", "token"]],
          },
        ],
      }),
    ).toEqual([["accounts", "0", "token"]]);
  });

  it("keeps earlier array sensitivity when a later include appends nothing", () => {
    expect(
      collectSensitiveIncludeSourcePaths({
        includeProvenance: [
          {
            path: ["accounts"],
            kind: "multiple",
            hasSiblingOverrides: false,
            sourceContributions: [
              {
                targetPath: "/tmp/base.json5",
                value: [{ token: "${TOKEN}" }],
                terminalContributedPaths: [["accounts"]],
              },
              {
                targetPath: "/tmp/override.json5",
                value: [],
                terminalContributedPaths: [["accounts"]],
              },
            ],
          },
        ],
      }),
    ).toEqual([["accounts", "0", "token"]]);
  });

  it("does not clear sensitivity for a later empty-object merge", () => {
    expect(
      collectSensitiveIncludeSourcePaths({
        includeProvenance: [
          {
            path: ["plugins"],
            kind: "single",
            hasSiblingOverrides: false,
            terminalContributedPaths: [["plugins", "token"]],
            sensitiveContributedPaths: [["plugins", "token"]],
          },
          {
            path: ["plugins"],
            kind: "single",
            hasSiblingOverrides: true,
            terminalContributedPaths: [],
            sensitiveContributedPaths: [],
          },
        ],
      }),
    ).toEqual([["plugins", "token"]]);
  });

  it("tracks sensitive values below a parsed __proto__ key", () => {
    expect(
      collectSensitiveIncludeSourcePaths({
        includeProvenance: [
          {
            path: ["plugins"],
            kind: "multiple",
            hasSiblingOverrides: false,
            sourceContributions: [
              {
                targetPath: "/tmp/plugins.json5",
                value: JSON.parse('{"__proto__":{"token":"${TOKEN}"}}'),
                terminalContributedPaths: [["plugins", "__proto__", "token"]],
              },
            ],
          },
        ],
      }),
    ).toEqual([["plugins", "__proto__", "token"]]);
  });

  it("rejects a runtime-shaped array edit when authored refs were resolved", () => {
    expect(() =>
      projectExplicitRuntimeValueOntoAuthored({
        authored: [{ token: "${A}" }, { token: "${B}" }],
        runtime: [{ token: "resolved-a" }, { token: "resolved-b" }],
        explicit: [{ token: "resolved-b" }],
        preserveResolvedLeaves: true,
      }),
    ).toThrow("cannot safely project a changed runtime-derived array");
  });

  it("replaces explicit source-shaped arrays atomically", () => {
    expect(
      projectExplicitRuntimeValueOntoAuthored({
        authored: [{ a: 1, b: 2 }],
        runtime: [{ a: 1, b: 2 }],
        explicit: [{ a: 3 }],
        preserveResolvedLeaves: false,
      }),
    ).toEqual([{ a: 3 }]);
  });

  it("authors runtime-default children beneath an explicit object path", () => {
    expect(
      projectExplicitRuntimeValueOntoAuthored({
        authored: { token: "${TOKEN}" },
        runtime: { token: "resolved-token", policy: "default" },
        explicit: { token: "resolved-token", policy: "default" },
        preserveResolvedLeaves: true,
      }),
    ).toEqual({ token: "${TOKEN}", policy: "default" });
  });

  it("preserves explicit null values when deriving operations from a complete candidate", () => {
    const base = { plugins: { entries: { demo: { config: { mode: "auto" } } } } };
    const target = {
      plugins: { entries: { demo: { config: { mode: null, nested: { value: null } } } } },
    };

    expect(applyConfigOperations(base, createConfigMutationOperations(base, target))).toEqual(
      target,
    );
  });

  it("rejects prototype-sensitive keys while deriving operations", () => {
    const target = JSON.parse('{"plugins":{"entries":{"demo":{"config":{"__proto__":{}}}}}}');
    expect(() => createConfigMutationOperations({}, target)).toThrow(
      "Blocked config key at plugins.entries.demo.config.__proto__",
    );
    const arrayTarget = JSON.parse('{"plugins":{"allow":[{"constructor":{}}]}}');
    expect(() => createConfigMutationOperations({}, arrayTarget)).toThrow(
      "Blocked config key at plugins.allow.0.constructor",
    );
  });

  it("marks deletions derived from a complete candidate as strict unsets", () => {
    expect(
      createConfigMutationOperations(
        { agents: { entries: { main: { default: true }, ops: {} } } },
        { agents: { entries: { main: { default: true } } } },
      ),
    ).toContainEqual({
      kind: "unset",
      path: ["agents", "entries", "ops"],
      strictIncludeOwnership: true,
    });
  });

  it("collects nested deletions inside positionally stable arrays", () => {
    expect(
      createConfigMutationOperations(
        { plugins: { load: { entries: [{ id: "a", enabled: true }] } } },
        { plugins: { load: { entries: [{ id: "a" }] } } },
      ),
    ).toContainEqual({
      kind: "unset",
      path: ["plugins", "load", "entries", "0", "enabled"],
      strictIncludeOwnership: true,
    });
  });

  it("replaces an array container when the target becomes an object", () => {
    const base = { plugins: { entries: [{ id: "legacy" }] } };
    const target = { plugins: { entries: { demo: { enabled: true } } } };
    const operations = createConfigMutationOperations(base, target);

    expect(operations).toEqual([
      {
        kind: "set",
        path: ["plugins", "entries"],
        value: { demo: { enabled: true } },
      },
    ]);
    expect(applyConfigOperations(base, operations)).toEqual(target);
  });

  it("applies explicit sets, indexed unsets, and merge patches immutably", () => {
    const source = {
      agents: { entries: { main: { skills: ["one", "two"] } } },
      gateway: { mode: "local" },
    };

    const result = applyConfigOperations(source, [
      { kind: "set", path: ["agents", "entries", "ops", "default"], value: true },
      { kind: "unset", path: ["agents", "entries", "main", "skills", "0"] },
      { kind: "merge", patch: { gateway: { port: 19001 } } },
    ]);

    expect(result).toEqual({
      agents: {
        entries: {
          main: { skills: ["two"] },
          ops: { default: true },
        },
      },
      gateway: { mode: "local", port: 19001 },
    });
    expect(source.agents.entries.main.skills).toEqual(["one", "two"]);
  });

  it("preserves numeric map keys when setting a nested value", () => {
    const source = {
      agents: {
        entries: {
          "2": { workspace: "/srv/two" },
          "10": { workspace: "/srv/ten" },
        },
      },
    };

    expect(
      applyConfigOperations(source, [
        { kind: "set", path: ["agents", "entries", "10", "default"], value: true },
      ]),
    ).toEqual({
      agents: {
        entries: {
          "2": { workspace: "/srv/two" },
          "10": { workspace: "/srv/ten", default: true },
        },
      },
    });
  });

  it("creates an absent array from candidate container hints", () => {
    expect(
      applyConfigOperations({}, [
        {
          kind: "set",
          path: ["plugins", "allow", "0"],
          value: "demo",
          arrayContainerDepths: [2],
        },
      ]),
    ).toEqual({ plugins: { allow: ["demo"] } });
  });

  it("rejects lossy runtime-derived container replacement", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: { plugins: { allow: ["${TOKEN}"] } },
        runtime: { plugins: { allow: ["resolved-token"] } },
        candidate: { plugins: { allow: ["resolved-token", "new"] } },
      }),
    ).toThrow("cannot safely replace runtime-derived container at plugins.allow");
  });

  it("rejects a runtime-derived map move into a new path", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: { plugins: { entries: { old: { token: "${TOKEN}" } } } },
        runtime: { plugins: { entries: { old: { token: "resolved-token" } } } },
        candidate: { plugins: { entries: { next: { token: "resolved-token" } } } },
      }),
    ).toThrow("cannot safely persist a runtime-derived value at plugins.entries.next");
  });

  it("allows removal of an authored runtime-resolved reference", () => {
    expect(
      createRuntimeConfigMutationOperations({
        source: { plugins: { entries: { old: { token: "${TOKEN}" } } } },
        runtime: { plugins: { entries: { old: { token: "resolved-token" } } } },
        candidate: { plugins: { entries: {} } },
      }),
    ).toContainEqual({
      kind: "unset",
      path: ["plugins", "entries", "old"],
      strictIncludeOwnership: true,
    });
  });

  it("allows an explicit replacement of a runtime-resolved leaf", () => {
    expect(
      createRuntimeConfigMutationOperations({
        source: { plugins: { entries: { old: { token: "${OLD_TOKEN}" } } } },
        runtime: { plugins: { entries: { old: { token: "old-token" } } } },
        candidate: { plugins: { entries: { old: { token: "new-token" } } } },
      }),
    ).toContainEqual({
      kind: "set",
      path: ["plugins", "entries", "old", "token"],
      value: "new-token",
    });
  });

  it("rejects a same-length runtime-derived array reorder", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: { plugins: { allow: ["${TOKEN}", "literal"] } },
        runtime: { plugins: { allow: ["resolved-token", "literal"] } },
        candidate: { plugins: { allow: ["literal", "resolved-token"] } },
      }),
    ).toThrow("cannot safely reorder runtime-derived array at plugins.allow");
  });

  it("rejects moving non-string resolved values across array indexes", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: { values: ["${A}", "${B}"] },
        runtime: { values: [false, true] },
        candidate: { values: [true, false] },
      }),
    ).toThrow("cannot safely reorder runtime-derived array at values");
  });

  it("allows unrelated edits beside unchanged duplicate resolved values", () => {
    expect(
      createRuntimeConfigMutationOperations({
        source: { values: ["${A}", "${B}", "old"] },
        runtime: { values: [false, false, "old"] },
        candidate: { values: [false, false, "new"] },
      }),
    ).toContainEqual({
      kind: "set",
      path: ["values", "2"],
      value: "new",
      arrayContainerDepths: [1],
    });
  });

  it("rejects an environment-resolved value copied to another path", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: { plugins: { allow: ["${TOKEN}"] } },
        runtime: { plugins: { allow: ["resolved-token"] } },
        candidate: {
          plugins: {
            allow: ["resolved-token"],
            entries: { demo: { config: { token: "resolved-token" } } },
          },
        },
      }),
    ).toThrow("cannot safely persist a runtime-derived value at plugins.entries.demo");
  });

  it("rejects an environment-resolved value copied into an object key", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: { token: "${TOKEN}", lookup: {} },
        runtime: { token: "credential", lookup: {} },
        candidate: { token: "credential", lookup: { credential: true } },
      }),
    ).toThrow("cannot safely persist a runtime-derived value in an object key");
  });

  it("does not treat unrelated runtime defaults as authored references", () => {
    expect(
      createRuntimeConfigMutationOperations({
        source: {},
        runtime: { agents: { entries: { main: { default: true } } } },
        candidate: {
          agents: { entries: { main: { default: true } } },
          browser: { enabled: true },
        },
      }),
    ).toContainEqual({ kind: "set", path: ["browser", "enabled"], value: true });
  });

  it("carries candidate array-container depths on runtime-derived indexed sets", () => {
    expect(
      createRuntimeConfigMutationOperations({
        source: { plugins: { allow: ["old"] } },
        runtime: { plugins: { allow: ["old"] } },
        candidate: { plugins: { allow: ["new"] } },
      }),
    ).toContainEqual({
      kind: "set",
      path: ["plugins", "allow", "0"],
      value: "new",
      arrayContainerDepths: [2],
    });
  });

  it("rejects indexed edits when runtime resolution changed array length", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: { plugins: { allow: ["authored"] } },
        runtime: { plugins: { allow: ["default", "authored"] } },
        candidate: { plugins: { allow: ["updated", "authored"] } },
      }),
    ).toThrow("cannot safely replace runtime-derived container at plugins.allow");
  });

  it("rejects nested indexed edits when runtime resolution changed an inner array length", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: { plugins: { entries: [{ args: ["authored"] }] } },
        runtime: { plugins: { entries: [{ args: ["default", "authored"] }] } },
        candidate: { plugins: { entries: [{ args: ["updated", "authored"] }] } },
      }),
    ).toThrow("cannot safely replace runtime-derived container at plugins.entries.0.args");
  });

  it("rejects a parent resize combined with a nested runtime-derived array edit", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: { plugins: { entries: [{ args: ["authored"] }] } },
        runtime: { plugins: { entries: [{ args: ["default", "authored"] }] } },
        candidate: {
          plugins: {
            entries: [{ args: ["updated", "authored"] }, { args: ["new"] }],
          },
        },
      }),
    ).toThrow("cannot safely replace runtime-derived container at plugins.entries");
  });

  it("rejects removing a path that exists only after runtime defaults", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: { plugins: {} },
        runtime: { plugins: { enabled: true } },
        candidate: { plugins: {} },
      }),
    ).toThrow("cannot safely remove runtime-derived value at plugins.enabled");
  });

  it("allows compatibility projection to ignore an unrepresentable runtime-only removal", () => {
    expect(
      createRuntimeConfigMutationOperations({
        source: { plugins: {} },
        runtime: { plugins: { enabled: true } },
        candidate: { plugins: {} },
        runtimeOnlyUnsetPolicy: "ignore",
      }),
    ).toContainEqual({
      kind: "unset",
      path: ["plugins", "enabled"],
      strictIncludeOwnership: true,
    });
  });

  it("carries an include-owned removal into the canonical ownership check", () => {
    expect(
      createRuntimeConfigMutationOperations({
        source: { plugins: { $include: "./plugins.json" } },
        runtime: { plugins: { enabled: true } },
        candidate: { plugins: {} },
      }),
    ).toContainEqual({
      kind: "unset",
      path: ["plugins", "enabled"],
      strictIncludeOwnership: true,
    });
  });

  it("ignores compatibility removal of an include-owned container", () => {
    expect(
      createRuntimeConfigMutationOperations({
        source: { plugins: { $include: "./plugins.json" } },
        runtime: { plugins: { enabled: true } },
        candidate: {},
        runtimeOnlyUnsetPolicy: "ignore",
      }),
    ).toEqual([]);
  });

  it("allows runtime implicit main projection when the roster is first authored", () => {
    expect(
      createRuntimeConfigMutationOperations({
        source: {},
        runtime: { agents: { entries: { main: { default: true } } } },
        candidate: { agents: { entries: { ops: { default: true } } } },
      }),
    ).toContainEqual({
      kind: "unset",
      path: ["agents", "entries", "main"],
      strictIncludeOwnership: true,
    });
  });

  it("allows moving the synthetic main default onto the first authored agent", () => {
    expect(
      createRuntimeConfigMutationOperations({
        source: {},
        runtime: { agents: { entries: { main: { default: true } } } },
        candidate: {
          agents: { entries: { main: {}, ops: { default: true } } },
        },
      }),
    ).toContainEqual({
      kind: "unset",
      path: ["agents", "entries", "main", "default"],
      strictIncludeOwnership: true,
    });
  });

  it("rejects copying an include-resolved sensitive value into a new path", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: { plugins: { entries: { old: { $include: "./secret.json" } } } },
        runtime: { plugins: { entries: { old: { token: "resolved-token" } } } },
        candidate: {
          plugins: {
            entries: {
              old: { token: "resolved-token" },
              next: { copiedToken: "resolved-token" },
            },
          },
        },
      }),
    ).toThrow("cannot safely persist a runtime-derived value at plugins.entries.next");
  });

  it("rejects copying an env-backed include value from a non-sensitive path", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: { plugins: { entries: { old: { $include: "./mode.json" } } } },
        runtime: { plugins: { entries: { old: { mode: "credential" } } } },
        candidate: {
          plugins: {
            entries: {
              old: { mode: "credential" },
              next: { config: { mode: "credential" } },
            },
          },
        },
        sensitiveSourcePaths: [["plugins", "entries", "old", "mode"]],
      }),
    ).toThrow("cannot safely persist a runtime-derived value at plugins.entries.next");
  });

  it("rejects copying an env-backed sibling beside an include marker", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: {
          plugins: {
            entries: { old: { $include: "./defaults.json", mode: "${PLUGIN_CREDENTIAL}" } },
          },
        },
        runtime: { plugins: { entries: { old: { mode: "credential" } } } },
        candidate: {
          plugins: {
            entries: {
              old: { mode: "credential" },
              next: { config: { mode: "credential" } },
            },
          },
        },
      }),
    ).toThrow("cannot safely persist a runtime-derived value at plugins.entries.next");
  });

  it("aligns env-backed sibling arrays after included array elements", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: {
          plugins: {
            entries: {
              old: {
                $include: "./defaults.json",
                accounts: [{ token: "${PLUGIN_CREDENTIAL}" }],
              },
            },
          },
        },
        runtime: {
          plugins: {
            entries: {
              old: {
                accounts: [{ name: "included" }, { token: "credential" }],
              },
            },
          },
        },
        candidate: {
          plugins: {
            entries: {
              old: { accounts: [{ name: "included" }, { token: "credential" }] },
              next: { config: { token: "credential" } },
            },
          },
        },
      }),
    ).toThrow("cannot safely persist a runtime-derived value at plugins.entries.next");
  });

  it("does not confuse unrelated scalar equality with include provenance", () => {
    expect(
      createRuntimeConfigMutationOperations({
        source: { plugins: { entries: { old: { $include: "./flags.json" } } } },
        runtime: { plugins: { entries: { old: { enabled: true } } } },
        candidate: {
          plugins: { entries: { old: { enabled: true } } },
          browser: { enabled: true },
        },
      }),
    ).toContainEqual({ kind: "set", path: ["browser", "enabled"], value: true });
  });

  it("allows an explicit string equal to a non-sensitive included value", () => {
    expect(
      createRuntimeConfigMutationOperations({
        source: { plugins: { entries: { old: { $include: "./mode.json" } } } },
        runtime: { plugins: { entries: { old: { mode: "auto" } } } },
        candidate: {
          plugins: { entries: { old: { mode: "auto" } } },
          browser: { profiles: { demo: { mode: "auto" } } },
        },
      }),
    ).toContainEqual({
      kind: "set",
      path: ["browser", "profiles", "demo", "mode"],
      value: "auto",
    });
  });

  it("rejects copying a SecretRef-resolved value from an arbitrary plugin key", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: {
          plugins: {
            entries: {
              demo: {
                config: {
                  credential: { source: "env", provider: "default", id: "PLUGIN_CREDENTIAL" },
                },
              },
            },
          },
        },
        runtime: {
          plugins: { entries: { demo: { config: { credential: "resolved-credential" } } } },
        },
        candidate: {
          plugins: {
            entries: {
              demo: { config: { credential: "resolved-credential" } },
              next: { config: { copied: "resolved-credential" } },
            },
          },
        },
      }),
    ).toThrow("cannot safely persist a runtime-derived value at plugins.entries.next");
  });

  it("rejects copying an environment-resolved value from an arbitrary plugin key", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: {
          plugins: {
            entries: { demo: { config: { value: "${PLUGIN_CREDENTIAL}" } } },
          },
        },
        runtime: {
          plugins: { entries: { demo: { config: { value: "resolved-credential" } } } },
        },
        candidate: {
          plugins: {
            entries: {
              demo: { config: { value: "resolved-credential" } },
              next: { config: { copied: "resolved-credential" } },
            },
          },
        },
      }),
    ).toThrow("cannot safely persist a runtime-derived value at plugins.entries.next");
  });

  it("allows unrelated values that merely equal a non-sensitive environment default", () => {
    expect(
      createRuntimeConfigMutationOperations({
        source: { plugins: { entries: { demo: { config: { enabled: "${OPS_DEFAULT}" } } } } },
        runtime: { plugins: { entries: { demo: { config: { enabled: false } } } } },
        candidate: {
          plugins: {
            entries: {
              demo: { config: { enabled: false } },
              next: { config: { enabled: false } },
            },
          },
        },
      }),
    ).toContainEqual({
      kind: "set",
      path: ["plugins", "entries", "next", "config", "enabled"],
      value: false,
    });
  });

  it("rejects copying a runtime-only sensitive overlay into authored config", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: { gateway: { auth: { mode: "token" } } },
        runtime: { gateway: { auth: { mode: "token", token: "runtime-token" } } },
        candidate: {
          gateway: { auth: { mode: "token", token: "runtime-token" } },
          plugins: { entries: { demo: { config: { copied: "runtime-token" } } } },
        },
      }),
    ).toThrow("cannot safely persist a runtime-derived value at plugins.entries.demo");
  });
});
