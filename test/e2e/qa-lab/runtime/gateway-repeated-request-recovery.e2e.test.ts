import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { startQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";

type StabilityEvent = {
  seq?: unknown;
  type?: unknown;
  action?: unknown;
  reason?: unknown;
  outcome?: unknown;
  ageMs?: unknown;
};

type StabilitySnapshot = {
  lastSeq?: unknown;
  events?: StabilityEvent[];
};

type GatewayChatRun = {
  runId?: unknown;
  status?: unknown;
  stopReason?: unknown;
};

const RECOVERY_PROMPT =
  "Repeated request recovery Gateway QA check. Keep attempting without producing a reply.";
const QUEUED_PROMPT =
  "Repeated request queued reply Gateway QA check. Reply with the fixture marker.";
const RECOVERY_REASON = "repeated_model_requests_without_progress";
const PRODUCTION_RECOVERY_BOUND_MS = 360_000;

let harness: Awaited<ReturnType<typeof startQaLiveLaneGateway>> | undefined;

afterEach(async () => {
  await harness?.stop().catch(() => undefined);
  harness = undefined;
});

async function readStability(
  gateway: Awaited<ReturnType<typeof startQaLiveLaneGateway>>["gateway"],
  sinceSeq?: number,
): Promise<StabilitySnapshot> {
  return (await gateway.call(
    "diagnostics.stability",
    { limit: 1000, ...(sinceSeq === undefined ? {} : { sinceSeq }) },
    { timeoutMs: 10_000 },
  )) as StabilitySnapshot;
}

async function waitForStability(
  gateway: Awaited<ReturnType<typeof startQaLiveLaneGateway>>["gateway"],
  sinceSeq: number,
  predicate: (events: StabilityEvent[]) => boolean,
  timeoutMs: number,
): Promise<StabilityEvent[]> {
  const startedAt = Date.now();
  let latest: StabilityEvent[] = [];
  while (Date.now() - startedAt < timeoutMs) {
    latest = (await readStability(gateway, sinceSeq)).events ?? [];
    if (predicate(latest)) {
      return latest;
    }
    await sleep(1_000);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for stability events: ${JSON.stringify(latest)}`,
  );
}

describe("Gateway repeated-request recovery", () => {
  it(
    "aborts the real stalled owner once and releases one queued followup",
    { timeout: 510_000 },
    async () => {
      harness = await startQaLiveLaneGateway({
        repoRoot: process.cwd(),
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        transport: {
          requiredPluginIds: [],
          createGatewayConfig: () => ({
            messages: { queue: { mode: "followup" } },
          }),
        },
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        mutateConfig: (config) => ({ ...config, diagnostics: { enabled: true } }),
      });
      const { gateway } = harness;

      const baseline = await readStability(gateway);
      const baselineSeq = typeof baseline.lastSeq === "number" ? baseline.lastSeq : 0;
      const sessionKey = `agent:qa:repeated-request-recovery-${randomUUID()}`;
      const active = (await gateway.call(
        "chat.send",
        {
          sessionKey,
          message: RECOVERY_PROMPT,
          deliver: false,
          idempotencyKey: randomUUID(),
        },
        { timeoutMs: 30_000 },
      )) as GatewayChatRun;
      expect(active).toMatchObject({ status: "started" });
      expect(typeof active.runId).toBe("string");

      await waitForStability(
        gateway,
        baselineSeq,
        (events) => events.filter((event) => event.type === "model.call.started").length >= 2,
        150_000,
      );

      const queued = (await gateway.call(
        "chat.send",
        {
          sessionKey,
          message: QUEUED_PROMPT,
          queueMode: "followup",
          deliver: false,
          idempotencyKey: randomUUID(),
        },
        { timeoutMs: 30_000 },
      )) as GatewayChatRun;
      expect(queued).toMatchObject({ status: "started" });
      expect(typeof queued.runId).toBe("string");

      const events = await waitForStability(
        gateway,
        baselineSeq,
        (records) => records.some((event) => event.type === "session.recovery.completed"),
        350_000,
      );
      const stalled = events.filter(
        (event) => event.type === "session.stalled" && event.reason === RECOVERY_REASON,
      );
      const requested = events.filter(
        (event) => event.type === "session.recovery.requested" && event.reason === RECOVERY_REASON,
      );
      const completed = events.filter((event) => event.type === "session.recovery.completed");

      expect(stalled).toHaveLength(1);
      expect(stalled[0]?.ageMs).toEqual(expect.any(Number));
      expect(stalled[0]?.ageMs as number).toBeGreaterThanOrEqual(PRODUCTION_RECOVERY_BOUND_MS);
      expect(requested).toEqual([
        expect.objectContaining({ action: "abort", reason: RECOVERY_REASON }),
      ]);
      expect(completed).toEqual([
        expect.objectContaining({ action: "abort_embedded_run", outcome: "aborted" }),
      ]);
      expect(
        events.filter((event) => event.type === "model.call.started").length,
      ).toBeGreaterThanOrEqual(3);

      const activeTerminal = (await gateway.call(
        "agent.wait",
        { runId: active.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      )) as GatewayChatRun;
      expect(activeTerminal.status).not.toBe("ok");

      const queuedTerminal = (await gateway.call(
        "agent.wait",
        { runId: queued.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      )) as GatewayChatRun;
      expect(queuedTerminal.status).toBe("ok");

      const finalEvents = (await readStability(gateway, baselineSeq)).events ?? [];
      expect(
        finalEvents.filter((event) => event.type === "session.recovery.requested"),
      ).toHaveLength(1);
      expect(
        finalEvents.filter((event) => event.type === "session.recovery.completed"),
      ).toHaveLength(1);
    },
  );
});
