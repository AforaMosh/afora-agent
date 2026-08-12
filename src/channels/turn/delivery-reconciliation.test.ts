import { describe, expect, it } from "vitest";
import { reconcileNonVisibleChannelDeliveries } from "./delivery-reconciliation.js";

const none = { tool: 0, block: 0, final: 0 } as const;

describe("channel delivery reconciliation", () => {
  it("removes delivered when every final is authoritatively non-visible", () => {
    expect(
      reconcileNonVisibleChannelDeliveries(
        {
          queuedFinal: true,
          counts: { tool: 0, block: 0, final: 1 },
          deliveryTerminal: { outcome: "delivered" },
        },
        { ...none, final: 1 },
      ),
    ).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
  });

  it("keeps delivered while another final remains visible", () => {
    expect(
      reconcileNonVisibleChannelDeliveries(
        {
          queuedFinal: true,
          counts: { tool: 0, block: 0, final: 2 },
          deliveryTerminal: { outcome: "delivered" },
        },
        { ...none, final: 1 },
      ),
    ).toEqual({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
      deliveryTerminal: { outcome: "delivered" },
    });
  });

  it("keeps a non-delivered terminal when visible counts reconcile to zero", () => {
    expect(
      reconcileNonVisibleChannelDeliveries(
        {
          queuedFinal: true,
          counts: { tool: 0, block: 0, final: 1 },
          deliveryTerminal: { outcome: "unknown", retryable: false },
        },
        { ...none, final: 1 },
      ),
    ).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      deliveryTerminal: { outcome: "unknown", retryable: false },
    });
  });
});
