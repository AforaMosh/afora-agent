/** Tests process-local ACP permission helpers. */
import { describe, expect, it } from "vitest";
import { buildAcpPermissionOptions, resolveAcpApprovalDecision } from "./permission-relay.js";

describe("ACP permission helpers", () => {
  it("maps only selected approval options that ACP was offered", () => {
    const options = buildAcpPermissionOptions(["allow-always", "deny"]);

    expect(
      resolveAcpApprovalDecision(
        { outcome: { outcome: "selected", optionId: "allow-always" } },
        options,
      ),
    ).toBe("allow-always");
    expect(
      resolveAcpApprovalDecision(
        { outcome: { outcome: "selected", optionId: "allow-once" } },
        options,
      ),
    ).toBeUndefined();
    expect(
      resolveAcpApprovalDecision({ outcome: { outcome: "cancelled" } }, options),
    ).toBeUndefined();
  });

  it("preserves an empty authoritative approval decision set", () => {
    expect(buildAcpPermissionOptions([])).toEqual([]);
  });

  it("emits each offered decision once in stable order", () => {
    expect(
      buildAcpPermissionOptions(["deny", "allow-once", "deny", "allow-always"]).map(
        (option) => option.optionId,
      ),
    ).toEqual(["allow-once", "allow-always", "deny"]);
  });
});
