import { describe, expect, it, vi } from "vitest";
import {
  measureRealtimeTalkRawEventBytes,
  RealtimeTalkAdoptionGate,
} from "./realtime-talk-adoption-gate.ts";

function createGate(options: { maxCount?: number; maxBytes?: number } = {}) {
  const consume = vi.fn();
  const onOverflow = vi.fn();
  const gate = new RealtimeTalkAdoptionGate<string>({
    maxCount: options.maxCount ?? 3,
    maxBytes: options.maxBytes ?? 20,
    measure: (event) => event.length,
    consume,
    onOverflow,
  });
  return { consume, gate, onOverflow };
}

describe("RealtimeTalkAdoptionGate", () => {
  it("buffers pending events and drains them in provider order on adoption", () => {
    const { consume, gate } = createGate();

    expect(gate.push("first")).toBe(true);
    expect(gate.push("second")).toBe(true);
    expect(consume).not.toHaveBeenCalled();

    expect(gate.adopt()).toBe(true);
    expect(consume.mock.calls.map(([event]) => event)).toEqual(["first", "second"]);
    gate.push("third");
    expect(consume.mock.calls.map(([event]) => event)).toEqual(["first", "second", "third"]);
  });

  it("appends reentrant events behind the older pending queue", () => {
    const consumed: string[] = [];
    const gate = new RealtimeTalkAdoptionGate<string>({
      maxCount: 4,
      maxBytes: 20,
      measure: (event) => event.length,
      consume: (event) => {
        consumed.push(event);
        if (event === "first") {
          expect(gate.currentState).toBe("draining");
          gate.push("third");
        }
      },
      onOverflow: vi.fn(),
    });
    gate.push("first");
    gate.push("second");

    expect(gate.adopt()).toBe(true);

    expect(consumed).toEqual(["first", "second", "third"]);
    expect(gate.currentState).toBe("adopted");
  });

  it("discards provisional events without exposing them", () => {
    const { consume, gate } = createGate();

    gate.push("first");
    gate.discard();

    expect(gate.adopt()).toBe(false);
    expect(gate.push("second")).toBe(false);
    expect(consume).not.toHaveBeenCalled();
  });

  it.each([
    { options: { maxCount: 1 }, events: ["a", "b"] },
    { options: { maxBytes: 2 }, events: ["abc"] },
  ])("fails closed when the pending bound is exceeded", ({ events, options }) => {
    const { consume, gate, onOverflow } = createGate(options);

    for (const event of events) {
      gate.push(event);
    }

    expect(gate.currentState).toBe("discarded");
    expect(onOverflow).toHaveBeenCalledOnce();
    expect(consume).not.toHaveBeenCalled();
  });

  it("measures binary browser frames without string coercion", () => {
    expect(measureRealtimeTalkRawEventBytes(new Uint8Array(12), 10)).toBe(12);
    expect(measureRealtimeTalkRawEventBytes(new ArrayBuffer(14), 10)).toBe(14);
    expect(measureRealtimeTalkRawEventBytes({ byteLength: 1 }, 10)).toBe(11);
  });
});
