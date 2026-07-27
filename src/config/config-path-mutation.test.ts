import { describe, expect, it } from "vitest";
import { applyConfigOperations, createConfigMutationOperations } from "./config-path-mutation.js";

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
});
