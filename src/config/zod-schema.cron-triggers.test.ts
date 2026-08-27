import { describe, expect, it } from "vitest";
import { AforaSchema } from "./zod-schema.js";

describe("AforaSchema cron triggers", () => {
  it("accepts the strict trigger gate", () => {
    expect(AforaSchema.parse({ cron: { triggers: { enabled: true } } }).cron?.triggers).toEqual({
      enabled: true,
    });
  });

  it("rejects invalid and unknown trigger settings", () => {
    expect(
      AforaSchema.safeParse({ cron: { triggers: { enabled: true, extra: true } } }).success,
    ).toBe(false);
  });
});
