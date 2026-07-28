// Diagnostic phase tests cover phase timing and diagnostic event emission.
import { describe, expect, it } from "vitest";
import {
  getRecentDiagnosticPhases,
  resetDiagnosticPhasesForTest,
  withDiagnosticPhase,
  withDiagnosticPhaseSync,
} from "./diagnostic-phase.js";

describe("getRecentDiagnosticPhases", () => {
  it("returns an empty list for zero, negative, and non-finite limits", async () => {
    resetDiagnosticPhasesForTest();
    await withDiagnosticPhase("phase-a", () => undefined);
    await withDiagnosticPhase("phase-b", () => undefined);

    expect(getRecentDiagnosticPhases(0)).toEqual([]);
    expect(getRecentDiagnosticPhases(-1)).toEqual([]);
    expect(getRecentDiagnosticPhases(Number.NaN)).toEqual([]);
    expect(getRecentDiagnosticPhases(Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("returns the most recent phases for positive limits", async () => {
    resetDiagnosticPhasesForTest();
    await withDiagnosticPhase("phase-a", () => undefined);
    await withDiagnosticPhase("phase-b", () => undefined);

    const recent = getRecentDiagnosticPhases(1);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.name).toBe("phase-b");
  });

  it("records memory bounds for asynchronous phases", async () => {
    resetDiagnosticPhasesForTest();

    await withDiagnosticPhase("phase-memory", () => undefined);

    const phase = getRecentDiagnosticPhases(1)[0];
    expect(phase?.memoryStarted).toEqual({
      rssBytes: expect.any(Number),
      heapTotalBytes: expect.any(Number),
      heapUsedBytes: expect.any(Number),
      externalBytes: expect.any(Number),
      arrayBuffersBytes: expect.any(Number),
    });
    expect(phase?.memoryEnded).toEqual({
      rssBytes: expect.any(Number),
      heapTotalBytes: expect.any(Number),
      heapUsedBytes: expect.any(Number),
      externalBytes: expect.any(Number),
      arrayBuffersBytes: expect.any(Number),
    });
    expect(phase?.rssDeltaBytes).toEqual(expect.any(Number));
    expect(phase?.heapUsedDeltaBytes).toEqual(expect.any(Number));
  });

  it("records synchronous phases without changing their return contract", () => {
    resetDiagnosticPhasesForTest();

    const result = withDiagnosticPhaseSync("phase-sync", () => "result");

    expect(result).toBe("result");
    expect(getRecentDiagnosticPhases(1)[0]).toMatchObject({
      name: "phase-sync",
      memoryStarted: {
        heapUsedBytes: expect.any(Number),
      },
      memoryEnded: {
        heapUsedBytes: expect.any(Number),
      },
    });
  });
});
