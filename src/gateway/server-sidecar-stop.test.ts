import { describe, expect, it, vi } from "vitest";
import {
  stopRegisteredSidecarGroupsForClose,
  stopRegisteredSidecars,
} from "./server-sidecar-stop.js";

describe("stopRegisteredSidecars", () => {
  it("stops later sidecars before surfacing the first failure", async () => {
    const firstFailure = new Error("first stop failed");
    const secondFailure = new Error("second stop failed");
    const stopFirst = vi.fn(async () => {
      throw firstFailure;
    });
    const stopSecond = vi.fn(() => {
      throw secondFailure;
    });
    const stopLast = vi.fn();
    const log = { warn: vi.fn() };

    await expect(
      stopRegisteredSidecars({
        sidecars: [{ stop: stopFirst }, { stop: stopSecond }, { stop: stopLast }],
        label: "post-ready",
        log,
      }),
    ).rejects.toBe(firstFailure);

    expect(stopFirst).toHaveBeenCalledOnce();
    expect(stopSecond).toHaveBeenCalledOnce();
    expect(stopLast).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});

describe("stopRegisteredSidecarGroupsForClose", () => {
  it("contains one group failure so later groups and gateway teardown can continue", async () => {
    const firstFailure = new Error("gateway-lifetime stop failed");
    const events: string[] = [];
    const firstGroup = vi.fn(async () => {
      events.push("gateway-lifetime");
      throw firstFailure;
    });
    const secondGroup = vi.fn(() => {
      events.push("post-ready");
    });

    await stopRegisteredSidecarGroupsForClose([firstGroup, secondGroup]);
    events.push("gateway-teardown");

    expect(firstGroup).toHaveBeenCalledOnce();
    expect(secondGroup).toHaveBeenCalledOnce();
    expect(events).toEqual(["gateway-lifetime", "post-ready", "gateway-teardown"]);
  });
});
