import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import {
  QA_EVIDENCE_FILENAME,
  attachQaEvidenceScorecard,
  validateQaEvidenceSummaryJson,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { qaProfileEvidencePlan, type QaProfileEvidencePlan } from "./profile-evidence-plan.js";
import { buildQaProfileScorecardEvidence } from "./scorecard-evidence.js";
import type { QaScorecardCategoryCoverageReport } from "./scorecard-taxonomy.js";

type Cell = QaProfileEvidencePlan["expectedCells"][number];
type Ref = { path: string; sha256: string };
export type QaProfileRunSpec = Omit<
  Parameters<typeof qaProfileEvidencePlan.build>[0],
  "expectedCells" | "observedCells"
> & {
  evidenceMode?: QaEvidenceSummaryJson["evidenceMode"];
  filters: { surface?: string; category?: string };
  categories: readonly QaScorecardCategoryCoverageReport[];
};
export type QaProfilePhaseRetry = <T>(phase: string, run: () => Promise<T>) => Promise<T>;
export const runQaProfilePhase = <T>(
  retryPhase: QaProfilePhaseRetry | undefined,
  phase: string,
  run: () => Promise<T>,
) => (retryPhase ? retryPhase(phase, run) : run());
export type QaProfileRunControl = {
  complete(input: { scenarioId: string; evidence: QaEvidenceSummaryJson }): Promise<void>;
  hasTerminalEvidence(): boolean;
  retryPhase: QaProfilePhaseRetry;
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const key = (cell: Cell) => `${cell.scenarioId}\0${cell.executionKind}\0${cell.channel ?? ""}`;

export async function createQaProfileRunCheckpoint(params: {
  expectedCells: readonly Cell[];
  outputDir: string;
  retryPhase: QaProfilePhaseRetry;
  spec: QaProfileRunSpec;
}) {
  const plan = (observedCells: readonly Cell[]) =>
    qaProfileEvidencePlan.build({
      ...params.spec,
      expectedCells: params.expectedCells,
      observedCells,
    });
  const cells = new Map(plan([]).expectedCells.map((cell) => [key(cell), cell]));
  const refs = new Map<string, Ref>();
  const checkpointPath = path.join(params.outputDir, "qa-profile-run-checkpoint.json");
  const snapshot = (next?: readonly [string, Ref]) => ({
    cells: [...cells].map(([cellKey, cell]) => ({
      ...cell,
      evidence: cellKey === next?.[0] ? next[1] : refs.get(cellKey),
    })),
  });
  const read = async (ref: Ref) => {
    const payload = await fs.readFile(path.join(params.outputDir, ref.path), "utf8");
    if (hash(payload) !== ref.sha256) {
      throw new Error(`QA profile evidence digest mismatch: ${ref.path}`);
    }
    return validateQaEvidenceSummaryJson(JSON.parse(payload));
  };
  const getCell = (cell: Cell) => {
    const stored = cells.get(key(cell));
    if (!stored) {
      throw new Error(`QA profile checkpoint does not expect cell ${key(cell)}`);
    }
    return stored;
  };
  let queue: Promise<unknown> = Promise.resolve();
  const mutate = <T>(run: () => Promise<T>) => {
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next;
  };
  await params.retryPhase("checkpoint persistence", () =>
    writeJsonFileAtomically(checkpointPath, snapshot()),
  );
  const complete = (cell: Cell, input: QaEvidenceSummaryJson) =>
    mutate(async () => {
      const cellKey = key(cell);
      const evidence = validateQaEvidenceSummaryJson({ ...input, profileCell: cell });
      const sha256 = hash(`${JSON.stringify(evidence, null, 2)}\n`);
      const existing = refs.get(cellKey);
      if (existing?.sha256 === sha256) {
        return;
      }
      if (existing) {
        throw new Error(`QA profile checkpoint rejects replacement evidence for ${cellKey}`);
      }
      const ref = { path: path.join("qa-profile-evidence", `${sha256}.json`), sha256 };
      await params.retryPhase("checkpoint persistence", async () => {
        await writeJsonFileAtomically(path.join(params.outputDir, ref.path), evidence);
        await writeJsonFileAtomically(checkpointPath, snapshot([cellKey, ref]));
      });
      refs.set(cellKey, ref);
    });
  return {
    control(partitionCells: readonly Cell[]): QaProfileRunControl {
      const partition = new Map(
        partitionCells.map((cell) => [cell.scenarioId, getCell(cell)] as const),
      );
      return {
        complete: ({ scenarioId, evidence }) => {
          const cell = partition.get(scenarioId);
          if (!cell) {
            throw new Error(`QA profile partition does not expect scenario ${scenarioId}`);
          }
          return complete(cell, evidence);
        },
        hasTerminalEvidence: () => [...partition.values()].some((cell) => refs.has(key(cell))),
        retryPhase: params.retryPhase,
      };
    },
    finalize: (authoritativeEvidence: QaEvidenceSummaryJson) =>
      mutate(async () => {
        const base = validateQaEvidenceSummaryJson(authoritativeEvidence);
        const observed: Cell[] = [];
        for (const [cellKey, cell] of cells) {
          const ref = refs.get(cellKey);
          if (!ref) {
            continue;
          }
          const evidence = await read(ref);
          if (!evidence.profileCell || key(evidence.profileCell) !== cellKey) {
            throw new Error(`QA profile evidence ref is not bound to ${cellKey}`);
          }
          const { scenarioId, executionKind, channel } = cell;
          observed.push({ scenarioId, executionKind, channel });
        }
        const aggregate = attachQaEvidenceScorecard({
          summary: base,
          evidenceMode: params.spec.evidenceMode,
          profile: params.spec.profile,
          profilePlan: plan(observed),
          scorecard: buildQaProfileScorecardEvidence({
            evidence: base,
            filters: params.spec.filters,
            categories: params.spec.categories,
          }),
        });
        await params.retryPhase("profile finalization", () =>
          writeJsonFileAtomically(path.join(params.outputDir, QA_EVIDENCE_FILENAME), aggregate),
        );
        return aggregate;
      }),
  };
}
