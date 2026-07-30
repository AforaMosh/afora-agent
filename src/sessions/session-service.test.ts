import { describe, expect, it } from "vitest";
import { SessionService } from "./session-service.js";

describe("SessionService", () => {
  it("returns domain errors without Gateway protocol shapes", async () => {
    const service = new SessionService();

    await expect(
      service.resolve({
        config: {},
        selector: {},
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "invalid-selector",
        message: "Either key, sessionId, or label is required",
      },
    });
  });
});
