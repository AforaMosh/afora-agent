import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const FIXTURES = "test/fixtures/oxlint-type-evidence";
const cases = [
  {
    rule: "openclaw-type-evidence/no-object-parameters",
    violation: `${FIXTURES}/no-object-parameters-violation.ts`,
    violations: 3,
  },
  {
    rule: "openclaw-type-evidence/no-unknown-type-aliases",
    violation: `${FIXTURES}/no-unknown-type-aliases-violation.ts`,
    violations: 3,
  },
  {
    rule: "openclaw-type-evidence/no-widen-then-assert",
    violation: `${FIXTURES}/no-widen-then-assert-violation.ts`,
    violations: 2,
  },
];

function runRule(target: string) {
  return spawnSync(
    process.execPath,
    [
      "scripts/run-oxlint.mjs",
      "--openclaw-focused-config",
      "--config",
      "config/oxlint/type-evidence.json",
      target,
    ],
    { encoding: "utf8" },
  );
}

describe("oxlint type-evidence rules", () => {
  it.each(cases)("reports the intended $rule flows", (testCase) => {
    const violation = runRule(testCase.violation);
    const output = `${violation.stdout}${violation.stderr}`;
    expect(violation.status).toBe(1);
    expect(output.split(`${testCase.rule.replace("/", "(")})`)).toHaveLength(
      testCase.violations + 1,
    );
  });

  it("allows explicit unknown boundaries and preserved type evidence", () => {
    const result = runRule(`${FIXTURES}/valid.ts`);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("openclaw-type-evidence");
  });
});
