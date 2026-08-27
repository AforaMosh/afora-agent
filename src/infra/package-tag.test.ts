// Tests package tag parsing and stable release tag behavior.
import { describe, expect, it } from "vitest";
import { normalizePackageTagInput } from "./package-tag.js";

describe("normalizePackageTagInput", () => {
  const packageNames = ["afora", "@afora/plugin"] as const;

  it.each([
    { input: undefined, expected: null },
    { input: "   ", expected: null },
    { input: "afora@beta", expected: "beta" },
    { input: "@afora/plugin@2026.2.24", expected: "2026.2.24" },
    { input: "afora@   ", expected: null },
    { input: "afora", expected: null },
    { input: " @afora/plugin ", expected: null },
    { input: " latest ", expected: "latest" },
    { input: "@other/plugin@beta", expected: "@other/plugin@beta" },
    { input: "aforaer@beta", expected: "aforaer@beta" },
  ] satisfies ReadonlyArray<{ input: string | undefined; expected: string | null }>)(
    "normalizes %j",
    ({ input, expected }) => {
      expect(normalizePackageTagInput(input, packageNames)).toBe(expected);
    },
  );
});
