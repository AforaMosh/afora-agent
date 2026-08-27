import { describe, expect, it } from "vitest";
import { AforaSchema } from "./zod-schema.js";

describe("logging.audit.executionIdentity", () => {
  it("accepts only the explicit boolean config surface", () => {
    expect(
      AforaSchema.safeParse({
        logging: { audit: { executionIdentity: true } },
      }).success,
    ).toBe(true);
    expect(
      AforaSchema.safeParse({
        logging: { audit: { executionIdentity: false } },
      }).success,
    ).toBe(true);
    expect(
      AforaSchema.safeParse({
        logging: { audit: { executionIdentity: "true" } },
      }).success,
    ).toBe(false);
    expect(
      AforaSchema.safeParse({
        logging: { audit: { execution_identity: true } },
      }).success,
    ).toBe(false);
  });
});
