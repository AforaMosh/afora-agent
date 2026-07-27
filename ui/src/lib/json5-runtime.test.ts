// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isJson5Warm, parseJson5Text, warmJson5 } from "./json5-runtime.ts";

const COMMENTED = '// comment\n{\n  "a": 1, // trailing\n}\n';

describe("json5 runtime boundary", () => {
  it("parses strict JSON on the fast path", () => {
    expect(parseJson5Text('{"a":1}')).toEqual({ a: 1 });
  });

  it("shares concurrent warm-up and marks the JSON5 module as available", async () => {
    const firstWarmup = warmJson5();

    expect(warmJson5()).toBe(firstWarmup);
    await firstWarmup;
    expect(isJson5Warm()).toBe(true);
  });

  it("parses JSON5 text once the module is warmed", async () => {
    await warmJson5();
    expect(parseJson5Text(COMMENTED)).toEqual({ a: 1 });
  });

  it("still rejects malformed input after the JSON5 fallback is available", async () => {
    await warmJson5();

    expect(() => parseJson5Text("{ missing: ")).toThrow();
  });
});
