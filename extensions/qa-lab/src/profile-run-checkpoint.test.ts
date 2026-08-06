import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateQaEvidenceSummaryJson, type QaEvidenceSummaryJson } from "./evidence-summary.js";
import { readQaScenarioById } from "./scenario-catalog.js";

const atomicState = vi.hoisted(() => ({
  checkpointFailures: 0,
  writes: [] as string[],
}));

vi.mock("openclaw/plugin-sdk/json-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/json-store")>();
  return {
    ...actual,
    writeJsonFileAtomically: async (filePath: string, value: unknown) => {
      atomicState.writes.push(filePath);
      if (
        filePath.endsWith("qa-profile-run-checkpoint.json") &&
        atomicState.checkpointFailures > 0
      ) {
        atomicState.checkpointFailures -= 1;
        throw new Error("checkpoint disk full");
      }
      await actual.writeJsonFileAtomically(filePath, value);
    },
  };
});

import { createQaProfileRunCheckpoint } from "./profile-run-checkpoint.js";

const tempRoots: string[] = [];
const scenario = readQaScenarioById("channel-chat-baseline");
const cell = {
  scenarioId: scenario.id,
  executionKind: "flow" as const,
  channel: "qa-channel",
};

function evidence(generatedAt = "2026-08-06T00:00:00.000Z"): QaEvidenceSummaryJson {
  return validateQaEvidenceSummaryJson({
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt,
    evidenceMode: "full",
    entries: [
      {
        test: { kind: "flow", id: scenario.id, title: scenario.title },
        coverage: [],
        refs: [],
        result: { status: "pass" },
      },
    ],
  });
}

async function createCheckpoint() {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-profile-checkpoint-"));
  tempRoots.push(outputDir);
  const checkpoint = await createQaProfileRunCheckpoint({
    expectedCells: [cell],
    outputDir,
    retryPhase: async (_phase, run) => await run(),
    spec: {
      profile: "release",
      membershipScenarios: [scenario],
      selectedScenarios: [scenario],
      excludedScenarios: [],
      filters: {},
      categories: [],
    },
  });
  return { checkpoint, outputDir };
}

async function readCheckpoint(outputDir: string) {
  return JSON.parse(
    await fs.readFile(path.join(outputDir, "qa-profile-run-checkpoint.json"), "utf8"),
  ) as {
    cells: Array<typeof cell & { evidence?: { path: string; sha256: string } }>;
  };
}

describe("QA profile run checkpoint", () => {
  beforeEach(() => {
    atomicState.checkpointFailures = 0;
    atomicState.writes.length = 0;
  });

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("becomes terminal only after the checkpoint snapshot commits", async () => {
    const { checkpoint, outputDir } = await createCheckpoint();
    const control = checkpoint.control([cell]);
    atomicState.checkpointFailures = 1;

    await expect(
      control.complete({ scenarioId: scenario.id, evidence: evidence() }),
    ).rejects.toThrow("checkpoint disk full");
    expect(control.hasTerminalEvidence()).toBe(false);
    expect((await readCheckpoint(outputDir)).cells[0]).not.toHaveProperty("evidence");

    await control.complete({ scenarioId: scenario.id, evidence: evidence() });
    expect(control.hasTerminalEvidence()).toBe(true);
    expect((await readCheckpoint(outputDir)).cells[0]?.evidence?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds the canonical qa-channel cell and treats identical completion as idempotent", async () => {
    const { checkpoint, outputDir } = await createCheckpoint();
    const control = checkpoint.control([cell]);
    await control.complete({ scenarioId: scenario.id, evidence: evidence() });
    const checkpointWrites = atomicState.writes.filter((filePath) =>
      filePath.endsWith("qa-profile-run-checkpoint.json"),
    ).length;

    await control.complete({ scenarioId: scenario.id, evidence: evidence() });
    expect(
      atomicState.writes.filter((filePath) => filePath.endsWith("qa-profile-run-checkpoint.json")),
    ).toHaveLength(checkpointWrites);

    const ref = (await readCheckpoint(outputDir)).cells[0]?.evidence;
    expect(ref).toBeDefined();
    const stored = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(path.join(outputDir, ref!.path), "utf8")),
    );
    expect(stored.profileCell).toEqual(cell);
  });

  it("rejects replacement evidence after terminal completion", async () => {
    const { checkpoint } = await createCheckpoint();
    const control = checkpoint.control([cell]);
    await control.complete({ scenarioId: scenario.id, evidence: evidence() });

    await expect(
      control.complete({
        scenarioId: scenario.id,
        evidence: evidence("2026-08-06T00:00:01.000Z"),
      }),
    ).rejects.toThrow("rejects replacement evidence");
  });

  it("rejects tampered evidence refs during finalization", async () => {
    const { checkpoint, outputDir } = await createCheckpoint();
    await checkpoint.control([cell]).complete({ scenarioId: scenario.id, evidence: evidence() });
    const ref = (await readCheckpoint(outputDir)).cells[0]?.evidence;
    await fs.writeFile(path.join(outputDir, ref!.path), "{}\n", "utf8");

    await expect(checkpoint.finalize(evidence())).rejects.toThrow("evidence digest mismatch");
  });

  it("finalizes strict observed cells without changing authoritative entries", async () => {
    const { checkpoint, outputDir } = await createCheckpoint();
    await checkpoint.control([cell]).complete({ scenarioId: scenario.id, evidence: evidence() });
    const authoritative = evidence("2026-08-06T00:00:02.000Z");

    const finalized = await checkpoint.finalize(authoritative);

    expect(finalized.entries).toStrictEqual(authoritative.entries);
    expect(finalized.profilePlan?.observedCells).toEqual([cell]);
    expect(Object.keys(finalized.profilePlan!.observedCells[0]!).toSorted()).toEqual([
      "channel",
      "executionKind",
      "scenarioId",
    ]);
    expect(
      validateQaEvidenceSummaryJson(
        JSON.parse(await fs.readFile(path.join(outputDir, "qa-evidence.json"), "utf8")),
      ),
    ).toStrictEqual(finalized);
  });
});
