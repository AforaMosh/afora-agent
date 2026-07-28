import { describe, expect, it } from "vitest";
import {
  applyConfigOperations,
  createConfigMutationOperations,
  createRuntimeConfigMutationOperations,
} from "./config-path-mutation.js";

describe("applyConfigOperations", () => {
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

  it("rejects a same-length runtime-derived array reorder", () => {
    expect(() =>
      createRuntimeConfigMutationOperations({
        source: { plugins: { allow: ["${TOKEN}", "literal"] } },
        runtime: { plugins: { allow: ["resolved-token", "literal"] } },
        candidate: { plugins: { allow: ["literal", "resolved-token"] } },
      }),
    ).toThrow("cannot safely persist a runtime-derived value at plugins.allow.1");
  });

  it("rejects copying a resolved array value into a new path", () => {
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
    ).toThrow("cannot safely persist a runtime-derived value");
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

  it("rejects copying an include-resolved value into a new path", () => {
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
});
