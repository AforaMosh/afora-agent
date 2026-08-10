import { describe, expect, it } from "vitest";
import {
  analyzeShadowNameSources,
  findNewShadowNameDebt,
  toShadowNameDebtEntries,
  type ShadowNameSource,
} from "../../scripts/check-shadow-name-exports.mts";

function analyze(sources: Record<string, string>) {
  return analyzeShadowNameSources(
    Object.entries(sources).map(([path, source]) => ({ path, source }) satisfies ShadowNameSource),
  );
}

describe("shadow-name export guard", () => {
  it("finds definition collisions while exempting pure and forwarding wrappers", () => {
    const result = analyze({
      "src/collision-a.ts": "export function collides(value: string) { return value.trim(); }",
      "src/collision-b.ts": "export const collides = (value: string) => value.toUpperCase();",
      "src/reexport.ts": 'export { collides } from "./collision-a.js";',
      "src/static-core.ts": "export function staticForward(value: string) { return value; }",
      "src/static-runtime.ts": `
        import { staticForward as staticForwardImpl } from "./static-core.js";
        export function staticForward(value: string) { return staticForwardImpl(value); }
      `,
      "src/lazy-core.ts": "export async function lazyForward(...args: string[]) { return args; }",
      "src/lazy-runtime.ts": `
        export async function lazyForward(...args: string[]) {
          const runtime = await load();
          return runtime.lazyForward(...args);
        }
      `,
      "src/behavior-core.ts": "export function addsBehavior(value: string) { return value; }",
      "src/behavior-runtime.ts": `
        export function addsBehavior(value: string) {
          return runtime.addsBehavior(value.trim());
        }
      `,
      "src/receiver-core.ts": "export function receiverCall(value: string) { return value; }",
      "src/receiver-runtime.ts":
        "export function receiverCall(value: string) { return load().receiverCall(value); }",
    });

    expect(result.violations.map(({ name, path }) => ({ name, path }))).toEqual([
      { name: "addsBehavior", path: "src/behavior-core.ts" },
      { name: "addsBehavior", path: "src/behavior-runtime.ts" },
      { name: "collides", path: "src/collision-a.ts" },
      { name: "collides", path: "src/collision-b.ts" },
      { name: "receiverCall", path: "src/receiver-core.ts" },
      { name: "receiverCall", path: "src/receiver-runtime.ts" },
    ]);
  });

  it("allows return-await forwarding and ignores overload declarations within one file", () => {
    const result = analyze({
      "src/core.ts": "export async function forwarded(value: string) { return value; }",
      "src/runtime.ts":
        "export async function forwarded(value: string) { return await runtime.forwarded(value); }",
      "src/overload.ts": `
        export function overloaded(value: string): string;
        export function overloaded(value: number): number;
        export function overloaded(value: string | number) { return value; }
      `,
    });

    expect(result.violations).toEqual([]);
  });

  it("marks collisions exported through the plugin SDK", () => {
    const result = analyze({
      "src/a.ts": "export const sdkCollision = () => 1;",
      "src/b.ts": "export const sdkCollision = () => 2;",
      "src/plugin-sdk/runtime.ts": 'export { sdkCollision } from "../a.js";',
      "src/plugin-sdk/star.ts": 'export * from "../star-source.js";',
      "src/star-a.ts": "export const starCollision = () => 1;",
      "src/star-b.ts": "export const starCollision = () => 2;",
      "src/star-source.ts": 'export { starCollision } from "./star-a.js";',
    });

    expect(result.violations).toMatchObject([
      { name: "sdkCollision", sdk: true },
      { name: "sdkCollision", sdk: true },
      { name: "starCollision", sdk: true },
      { name: "starCollision", sdk: true },
    ]);
  });

  it("reports aliasing re-exports only outside the plugin SDK", () => {
    const result = analyze({
      "src/alias.ts": 'export { original as renamed } from "./source.js";',
      "src/plugin-sdk/alias.ts": 'export { original as sanctioned } from "../source.js";',
    });

    expect(result.aliases).toEqual([
      {
        exportedName: "renamed",
        importedName: "original",
        line: 1,
        moduleSpecifier: "./source.js",
        path: "src/alias.ts",
      },
    ]);
  });

  it("suppresses baseline debt, ignores removals, and exposes new violations", () => {
    const current = toShadowNameDebtEntries(
      analyze({
        "src/a.ts": "export const existing = () => 1; export const added = () => 1;",
        "src/b.ts": "export const existing = () => 2; export const added = () => 2;",
      }).violations,
    );
    const existing = current.filter((entry) => entry.name === "existing");
    const staleRemoved = { name: "removed", path: "src/old.ts", sdk: false };

    expect(findNewShadowNameDebt(current, [...existing, staleRemoved])).toEqual(
      current.filter((entry) => entry.name === "added"),
    );
    expect(findNewShadowNameDebt(existing, [...existing, staleRemoved])).toEqual([]);
  });
});
