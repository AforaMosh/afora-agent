// Matrix tests cover device health plugin behavior.
import { describe, expect, it } from "vitest";
import { isAforaManagedMatrixDevice, summarizeMatrixDeviceHealth } from "./device-health.js";

describe("matrix device health", () => {
  it("detects Afora-managed device names", () => {
    expect(isAforaManagedMatrixDevice("Afora Gateway")).toBe(true);
    expect(isAforaManagedMatrixDevice("Afora Debug")).toBe(true);
    expect(isAforaManagedMatrixDevice("Element iPhone")).toBe(false);
    expect(isAforaManagedMatrixDevice(null)).toBe(false);
  });

  it("summarizes stale Afora-managed devices separately from the current device", () => {
    const summary = summarizeMatrixDeviceHealth([
      {
        deviceId: "du314Zpw3A",
        displayName: "Afora Gateway",
        current: true,
      },
      {
        deviceId: "BritdXC6iL",
        displayName: "Afora Gateway",
        current: false,
      },
      {
        deviceId: "G6NJU9cTgs",
        displayName: "Afora Debug",
        current: false,
      },
      {
        deviceId: "phone123",
        displayName: "Element iPhone",
        current: false,
      },
    ]);

    expect(summary).toEqual({
      currentDeviceId: "du314Zpw3A",
      currentAforaDevices: [
        {
          deviceId: "du314Zpw3A",
          displayName: "Afora Gateway",
          current: true,
        },
      ],
      staleAforaDevices: [
        {
          deviceId: "BritdXC6iL",
          displayName: "Afora Gateway",
          current: false,
        },
        {
          deviceId: "G6NJU9cTgs",
          displayName: "Afora Debug",
          current: false,
        },
      ],
    });
  });
});
