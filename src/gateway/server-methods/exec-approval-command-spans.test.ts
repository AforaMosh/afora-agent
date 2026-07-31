import { describe, expect, it } from "vitest";
import { normalizeCommandSpans } from "./exec-approval-command-spans.js";

describe("normalizeCommandSpans", () => {
  it("orders valid non-overlapping spans and drops invalid or overlapping spans", () => {
    expect(
      normalizeCommandSpans(
        [
          { startIndex: 5, endIndex: 11 },
          { startIndex: 0, endIndex: 2 },
          { startIndex: 1, endIndex: 4 },
          { startIndex: 12, endIndex: 999 },
          { startIndex: 11, endIndex: 11 },
        ],
        26,
      ),
    ).toEqual([
      { startIndex: 0, endIndex: 2 },
      { startIndex: 5, endIndex: 11 },
    ]);
  });

  it("returns undefined when no spans survive normalization", () => {
    expect(
      normalizeCommandSpans(
        [
          { startIndex: -1, endIndex: 2 },
          { startIndex: 2, endIndex: 2 },
        ],
        10,
      ),
    ).toBeUndefined();
  });
});
