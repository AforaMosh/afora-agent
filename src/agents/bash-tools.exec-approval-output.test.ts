/**
 * Approved exec continuation output formatting tests.
 * Covers verbatim preservation under the cap, deterministic stream labeling,
 * surrogate-safe head/tail cuts, header-boundary handling, and exact omission
 * accounting above the cap.
 */
import { describe, expect, it } from "vitest";
import { formatExecApprovalContinuationOutput } from "./bash-tools.exec-approval-output.js";

// Pinned rather than imported: the module keeps its budget private, and pinning
// the resolved numbers makes any change to the cap or the head/tail split a
// deliberate edit here instead of a silent drift. These hold for inputs whose
// length is at most five digits and whose widest stream label is at most six
// UTF-16 units (`stdout`/`stderr`/`output`/`error`); larger inputs or longer
// labels widen the marker reserve.
const MAX = 16_000;
const HEAD = 11_921;
const TAIL = 3_974;
// Generated headers make a `tail resumes in <label>` suffix possible, which
// widens the reserved marker width and narrows the retained budget.
const HEAD_LABELED = 11_903;
const TAIL_LABELED = 3_968;
const HEADER = "[stdout]\n".length;

function marker(
  omitted: number,
  headUnits: number,
  tailUnits: number,
  resumingLabel?: string,
): string {
  const resuming = resumingLabel ? `; tail resumes in ${resumingLabel}` : "";
  return (
    `[... ${omitted} UTF-16 code units omitted from approved exec output; ` +
    `showing first ${headUnits} and last ${tailUnits}${resuming} ...]`
  );
}

describe("formatExecApprovalContinuationOutput", () => {
  it("returns an empty string when no stream carries content", () => {
    expect(formatExecApprovalContinuationOutput([])).toBe("");
    expect(
      formatExecApprovalContinuationOutput([
        { label: "stdout", value: "" },
        { label: "stderr", value: " \r\n\t " },
        { label: "error", value: null },
      ]),
    ).toBe("");
  });

  it("emits a lone stream verbatim without a label", () => {
    for (const label of ["stdout", "stderr", "error", "output"]) {
      expect(formatExecApprovalContinuationOutput([{ label, value: "only" }])).toBe("only");
    }
  });

  it("preserves newlines, tabs, indentation, and trailing whitespace", () => {
    const value = "first\r\n\tindented\n\n  spaced   \nlast\r\n  \t";
    expect(formatExecApprovalContinuationOutput([{ label: "output", value }])).toBe(value);
  });

  it("keeps an existing source-side truncation marker visible", () => {
    const value = `line one\nline two\n[source output truncated after 200000 bytes]\n`;
    expect(formatExecApprovalContinuationOutput([{ label: "stdout", value }])).toBe(value);
  });

  it("labels multiple streams in stdout, stderr, error order", () => {
    expect(
      formatExecApprovalContinuationOutput([
        { label: "stdout", value: "alpha\r\n  beta\t" },
        { label: "stderr", value: "warn\n\nnext" },
        { label: "error", value: "boom" },
      ]),
    ).toBe("[stdout]\nalpha\r\n  beta\t\n[stderr]\nwarn\n\nnext\n[error]\nboom");
  });

  it("skips blank streams when deciding whether to label", () => {
    expect(
      formatExecApprovalContinuationOutput([
        { label: "stdout", value: "  \n" },
        { label: "stderr", value: "only stderr" },
        { label: "error", value: null },
      ]),
    ).toBe("only stderr");
  });

  it("returns under-limit and exact-limit output unchanged", () => {
    for (const length of [1, MAX - 1, MAX]) {
      const value = "x".repeat(length);
      expect(formatExecApprovalContinuationOutput([{ label: "output", value }])).toBe(value);
    }
  });

  it("splits one over-limit stream into a marked head and tail", () => {
    const omittedCount = 500;
    const value = `${"h".repeat(HEAD)}${"m".repeat(omittedCount)}${"t".repeat(TAIL)}`;

    const formatted = formatExecApprovalContinuationOutput([{ label: "output", value }]);

    expect(formatted).toBe(
      `${"h".repeat(HEAD)}\n${marker(omittedCount, HEAD, TAIL)}\n${"t".repeat(TAIL)}`,
    );
    expect(formatted.length).toBeLessThanOrEqual(MAX);
  });

  it("accounts for every omitted unit and stays inside the cap", () => {
    const value = "z".repeat(MAX * 3 + 7);

    const formatted = formatExecApprovalContinuationOutput([{ label: "output", value }]);

    const match =
      /\[\.\.\. (\d+) UTF-16 code units omitted[^\]]+first (\d+) and last (\d+) \.\.\.\]/.exec(
        formatted,
      );
    expect(match).not.toBeNull();
    const [, omitted = 0, headUnits = 0, tailUnits = 0] = match!.map(Number);
    expect(omitted + headUnits + tailUnits).toBe(value.length);
    expect(formatted.length).toBeLessThanOrEqual(MAX);
  });

  it("holds the cap when the omitted count needs more digits than the cap itself", () => {
    // The omitted count scales with the input, so a fixed five-digit marker
    // reserve would overflow the cap once the input passes ~1M units.
    for (const total of [100_000, 1_016_000, 12_000_000]) {
      const formatted = formatExecApprovalContinuationOutput([
        { label: "output", value: "z".repeat(total) },
      ]);

      const match =
        /\[\.\.\. (\d+) UTF-16 code units omitted[^\]]+first (\d+) and last (\d+) \.\.\.\]/.exec(
          formatted,
        );
      expect(match).not.toBeNull();
      const [, omitted = 0, headUnits = 0, tailUnits = 0] = match!.map(Number);
      expect(omitted + headUnits + tailUnits).toBe(total);
      expect(formatted.length).toBeLessThanOrEqual(MAX);
    }
  });

  it("never splits a surrogate pair at either cut", () => {
    const middle = 1_000;
    const value = `${"h".repeat(HEAD - 1)}😀${"m".repeat(middle)}😀${"t".repeat(TAIL - 1)}`;

    const formatted = formatExecApprovalContinuationOutput([{ label: "output", value }]);

    expect(formatted).toBe(
      `${"h".repeat(HEAD - 1)}\n${marker(middle + 4, HEAD - 1, TAIL - 1)}\n${"t".repeat(TAIL - 1)}`,
    );
    expect(formatted).not.toContain("\ud83d\n");
    expect(formatted.length).toBeLessThanOrEqual(MAX);
  });

  it("moves a head cut that lands inside a generated header", () => {
    // Places `[stderr]\n` so the raw head budget falls in its middle.
    const stdout = "a".repeat(HEAD_LABELED - HEADER - 1 - 4);
    const stderr = "b".repeat(60_000);

    const formatted = formatExecApprovalContinuationOutput([
      { label: "stdout", value: stdout },
      { label: "stderr", value: stderr },
    ]);

    const total = HEADER + stdout.length + 1 + HEADER + stderr.length;
    const head = `[stdout]\n${stdout}\n`;
    const omitted = total - head.length - TAIL_LABELED;
    expect(formatted).toBe(
      `${head}\n${marker(omitted, head.length, TAIL_LABELED, "stderr")}\n${"b".repeat(TAIL_LABELED)}`,
    );
    expect(formatted).not.toMatch(/\[std(?!out\]\n|err\]\n)/);
    expect(formatted.length).toBeLessThanOrEqual(MAX);
  });

  it("moves a tail cut that lands inside a generated header", () => {
    // Places `[stderr]\n` so the raw tail cut falls in its middle.
    const stdout = "a".repeat(13_000);
    const stderr = "b".repeat(TAIL_LABELED - 5);

    const formatted = formatExecApprovalContinuationOutput([
      { label: "stdout", value: stdout },
      { label: "stderr", value: stderr },
    ]);

    const total = HEADER + stdout.length + 1 + HEADER + stderr.length;
    const head = `[stdout]\n${"a".repeat(HEAD_LABELED - HEADER)}`;
    const omitted = total - head.length - stderr.length;
    expect(formatted).toBe(
      `${head}\n${marker(omitted, head.length, stderr.length, "stderr")}\n${stderr}`,
    );
    expect(formatted).not.toMatch(/\[std(?!out\]\n|err\]\n)/);
    expect(formatted.length).toBeLessThanOrEqual(MAX);
  });

  it("omits the resuming label when the head already showed that header", () => {
    const stdout = "a".repeat(4);
    const stderr = "b".repeat(MAX * 2);

    const formatted = formatExecApprovalContinuationOutput([
      { label: "stdout", value: stdout },
      { label: "stderr", value: stderr },
    ]);

    const total = HEADER + stdout.length + 1 + HEADER + stderr.length;
    expect(formatted).toBe(
      `[stdout]\naaaa\n[stderr]\n${"b".repeat(HEAD_LABELED - 2 * HEADER - stdout.length - 1)}\n` +
        `${marker(total - HEAD_LABELED - TAIL_LABELED, HEAD_LABELED, TAIL_LABELED)}\n` +
        "b".repeat(TAIL_LABELED),
    );
    expect(formatted.length).toBeLessThanOrEqual(MAX);
  });
});
