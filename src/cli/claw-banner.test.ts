// Claw banner tests: static/animated gating and the final-frame invariant.
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { RuntimeEnv } from "../runtime.js";
import { printClawBanner } from "./claw-banner.js";

const runtimeStub = () => {
  const log = vi.fn();
  return { runtime: { log } as unknown as RuntimeEnv, log };
};

async function runAnimated(rng: () => number) {
  const chunks: string[] = [];
  const { runtime } = runtimeStub();
  await printClawBanner(runtime, {
    columns: 120,
    isTty: true,
    rich: true,
    env: {},
    rng,
    sleep: async () => {},
    write: (chunk) => chunks.push(chunk),
  });
  return chunks;
}

async function runStatic() {
  const { runtime, log } = runtimeStub();
  await printClawBanner(runtime, { columns: 120, isTty: false, env: {} });
  return stripAnsi(String(log.mock.calls[0]?.[0]))
    .split("\n")
    .filter((row) => row.length > 0);
}

const EXPECTED_MASCOT = [
  " •●●:.        .:●●•",
  ":●●●●:        :●●●●:",
  ".●●●●:.:•●●•:.:●●●●.",
  " .●●●: •●●●●• :●●●.",
  " ..:••●●●●●●●●••:..",
  ".::••••●●●●●●••••::.",
  " . .:  •●●●●•  :. .",
  "    .  :●●●●:  .",
  "      .●●●●●●.",
  "       :••••:",
] as const;

// The wordmark is DRAWN, not written, so /openclaw/i finds nothing in it and neither
// brandscan nor brandprobe can see what it spells. These rows are the only gate on it:
// they decode, six columns per glyph, to A F O R A.
const EXPECTED_WORDMARK = [
  "█▀▀▀█ █▀▀▀▀ █▀▀▀█ █▀▀▀█ █▀▀▀█",
  "█▀▀▀█ █▀▀▀  █   █ █▀▀▀▄ █▀▀▀█",
  "▀   ▀ ▀     ▀▀▀▀▀ ▀   ▀ ▀   ▀",
] as const;
// Mascot (20) + gap (3): where every wordmark row starts inside a composed line.
const WORDMARK_COL = 23;
// The retired art spelled OPENCLAW in the same glyph set. A codemod rewrote this
// file's comments and could not rewrite the pixels; this keeps it from coming back.
const RETIRED_WORDMARK_ROW = "█▀▀▀█ █▀▀▀█ █▀▀▀▀ █▄  █ █▀▀▀▀ █     █▀▀▀█ █   █";

describe("printClawBanner", () => {
  it("prints the static banner when not animatable", async () => {
    const { runtime, log } = runtimeStub();
    await printClawBanner(runtime, { columns: 120, isTty: false, env: {} });
    const output = stripAnsi(String(log.mock.calls[0]?.[0]));
    const rows = output.split("\n").filter((row) => row.length > 0);
    expect(rows.map((row) => row.slice(0, 20).trimEnd())).toEqual(EXPECTED_MASCOT);
    expect(rows.slice(3, 6).map((row) => row.slice(WORDMARK_COL).padEnd(29))).toEqual([
      ...EXPECTED_WORDMARK,
    ]);
    expect(output).not.toContain(RETIRED_WORDMARK_ROW);
  });

  it("keeps the wordmark inside the width that gates the art", async () => {
    // BANNER_WIDTH is a hand-kept constant; a wordmark wider than it would print
    // wrapped on the narrowest terminal the art is still offered to.
    const { runtime: wide, log: wideLog } = runtimeStub();
    await printClawBanner(wide, { columns: 53, isTty: false, env: {} });
    const rows = stripAnsi(String(wideLog.mock.calls[0]?.[0]))
      .split("\n")
      .filter((row) => row.length > 0);
    expect(rows).toHaveLength(EXPECTED_MASCOT.length);
    expect(Math.max(...rows.map((row) => [...row].length))).toBeLessThanOrEqual(53);

    const { runtime: narrow, log: narrowLog } = runtimeStub();
    await printClawBanner(narrow, { columns: 52, isTty: false, env: {} });
    expect(String(narrowLog.mock.calls[0]?.[0])).not.toContain("█");
  });

  it("stays static under CI even on a rich TTY", async () => {
    const { runtime, log } = runtimeStub();
    await printClawBanner(runtime, { columns: 120, isTty: true, rich: true, env: { CI: "1" } });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("falls back to the plain title on narrow terminals", async () => {
    const { runtime, log } = runtimeStub();
    await printClawBanner(runtime, { columns: 50, isTty: true, rich: true, env: {} });
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).toContain("AFORA");
    expect(output).not.toContain("█");
  });

  it("animates on a rich TTY and settles on the exact static banner", async () => {
    const staticRows = await runStatic();
    const chunks = await runAnimated(() => 0);
    expect(chunks[0]).toBe("\x1b[?25l");
    expect(chunks).toContain("\x1b[?25h");
    const frames = chunks.filter((chunk) => chunk.includes("\x1b[K"));
    expect(frames.length).toBeGreaterThan(10);
    expect(
      frames.some((frame) => {
        const [first = "", second = ""] = stripAnsi(frame).split("\n");
        return (
          first.slice(0, 20).trimEnd() === "•●•.:.        .:.•●•" &&
          second.slice(0, 20).trimEnd() === ":●●●•:        :•●●●:"
        );
      }),
    ).toBe(true);
    const finalRows = stripAnsi(frames[frames.length - 1] ?? "")
      .split("\n")
      .filter((row) => row.length > 0);
    expect(finalRows).toEqual(staticRows);
  });

  it("installs scoped signal handlers only while animating", async () => {
    const before = process.listenerCount("SIGINT");
    let during = -1;
    const { runtime } = runtimeStub();
    await printClawBanner(runtime, {
      columns: 120,
      isTty: true,
      rich: true,
      env: {},
      rng: () => 0.99,
      sleep: async () => {
        during = Math.max(during, process.listenerCount("SIGINT"));
      },
      write: () => {},
    });
    expect(during).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("settles on the static frame when parallel work finishes first", async () => {
    const staticRows = await runStatic();
    const chunks: string[] = [];
    const beforeSigint = process.listenerCount("SIGINT");
    let settle!: () => void;
    const settleWhen = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const { runtime } = runtimeStub();
    const banner = printClawBanner(runtime, {
      columns: 120,
      isTty: true,
      rich: true,
      env: {},
      rng: () => 0.99,
      settleWhen,
      sleep: () => new Promise<void>(() => {}),
      write: (chunk) => chunks.push(chunk),
    });

    expect(chunks[0]).toBe("\x1b[?25l");
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint + 1);
    settle();
    await expect(banner).resolves.toBe("settled");

    const frames = chunks.filter((chunk) => chunk.includes("\x1b[K"));
    const finalRows = stripAnsi(frames.at(-1) ?? "")
      .split("\n")
      .filter((row) => row.length > 0);
    expect(finalRows).toEqual(staticRows);
    expect(chunks.at(-2)).toBe("\x1b[?25h");
    expect(chunks.at(-1)).toBe("\n");
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
  });

  it("varies snips and shimmer passes with the rng", async () => {
    // rng below the thresholds adds a second shimmer pass and a second snip.
    const maximal = (await runAnimated(() => 0)).filter((c) => c.includes("\x1b[K"));
    const minimal = (await runAnimated(() => 0.99)).filter((c) => c.includes("\x1b[K"));
    expect(maximal.length).toBeGreaterThan(minimal.length);
  });
});
