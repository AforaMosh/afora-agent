// Isolated agent model preflight tests cover model readiness checks before cron runs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadRunCronIsolatedAgentTurn,
  logWarnMock,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  preflightCronModelProviderMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resetRunCronIsolatedAgentTurnHarness,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./isolated-agent/run.test-harness.js";
import { CronService } from "./service.js";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { cronStoreKey } from "./store/key.js";
import { readCronTaskRunHistoryPage } from "./task-run-history.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const providerCronStore = createCronStoreHarness({ prefix: "cron-provider-one-shot-retry-" });

function unavailableProviderPreflight() {
  return {
    status: "unavailable" as const,
    reason:
      "This automation uses ollama/qwen3:32b but the local provider preflight failed at " +
      "http://127.0.0.1:11434. The candidate is unavailable for this run; OpenClaw " +
      "will retry its provider preflight on a later scheduled run. Last error: ECONNREFUSED",
    provider: "ollama",
    model: "qwen3:32b",
    baseUrl: "http://127.0.0.1:11434",
    retryAfterMs: 300_000,
  };
}

function createProviderOneShotCron(params: { storePath: string; nowMs: () => number }) {
  const cfg = {
    agents: { defaults: { model: { primary: "ollama/qwen3:32b", fallbacks: [] } } },
    models: {
      providers: {
        ollama: { api: "ollama" as const, baseUrl: "http://127.0.0.1:11434", models: [] },
      },
    },
  };
  const runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"] = async (run) =>
    await runCronIsolatedAgentTurn({
      cfg,
      deps: {} as never,
      ...run,
      sessionKey: `cron:${run.job.id}`,
      lane: "cron",
    });
  return new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    defaultAgentId: "main",
    startupDeferredMissedAgentJobDelayMs: 0,
    nowMs: params.nowMs,
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob,
  });
}

describe("runCronIsolatedAgentTurn model provider preflight", () => {
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "ollama",
      model: "qwen3:32b",
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: {
          sessionId: "cron-session",
          updatedAt: 0,
          systemSent: false,
          skillsSnapshot: undefined,
        },
      }),
    );
  });

  it("skips isolated cron execution when the local model provider is unavailable", async () => {
    preflightCronModelProviderMock.mockResolvedValueOnce({
      status: "unavailable",
      reason:
        "Agent cron job uses ollama/qwen3:32b but the local provider preflight failed at http://127.0.0.1:11434.",
      provider: "ollama",
      model: "qwen3:32b",
      baseUrl: "http://127.0.0.1:11434",
      retryAfterMs: 300000,
    });

    const result = await runCronIsolatedAgentTurn({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "ollama/qwen3:32b",
              fallbacks: [],
            },
          },
        },
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      },
      deps: {} as never,
      job: {
        id: "dead-ollama",
        name: "Dead Ollama",
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        state: {},
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "summarize" },
        delivery: { mode: "none" },
      },
      message: "summarize",
      sessionKey: "cron:dead-ollama",
      lane: "cron",
    });

    expect(result.status).toBe("skipped");
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("qwen3:32b");
    expect(result.sessionId).toBe("cron-session");
    expect(result).toHaveProperty("retryAfterMs", 300_000);
    expect(result.error).toContain("local provider preflight failed");
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("retries an unavailable time-scheduled provider turn across a real SQLite service restart", async () => {
    const { storePath } = await providerCronStore.makeStorePath();
    let now = Date.parse("2026-07-31T12:00:00.000Z");
    preflightCronModelProviderMock.mockResolvedValueOnce(unavailableProviderPreflight());
    mockRunCronFallbackPassthrough();
    const first = createProviderOneShotCron({ storePath, nowMs: () => now });
    let restarted: CronService | undefined;

    try {
      await first.start();
      const job = await first.add({
        id: "local-provider-at-restart",
        name: "local provider at restart",
        enabled: true,
        schedule: { kind: "at", at: new Date(now + 1_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "deliver the reminder" },
        delivery: { mode: "none" },
      });
      now += 1_000;

      await expect(first.run(job.id, "due")).resolves.toEqual({ ok: true, ran: true });
      const skipped = (await first.list({ includeDisabled: true })).find(
        (candidate) => candidate.id === job.id,
      );
      expect(skipped).toMatchObject({
        enabled: true,
        state: {
          lastRunStatus: "skipped",
          consecutiveErrors: 0,
          consecutiveSkipped: 1,
          nextRunAtMs: now + unavailableProviderPreflight().retryAfterMs,
        },
      });
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(
        readCronTaskRunHistoryPage({ storeKey: cronStoreKey(storePath), jobId: job.id }).entries,
      ).toEqual([
        expect.objectContaining({
          status: "skipped",
          error: expect.stringContaining("local provider preflight failed"),
          nextRunAtMs: now + unavailableProviderPreflight().retryAfterMs,
        }),
      ]);

      first.stop();
      now += unavailableProviderPreflight().retryAfterMs;
      restarted = createProviderOneShotCron({ storePath, nowMs: () => now });
      await restarted.start();
      await vi.waitFor(
        async () => {
          expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
          expect(
            (await restarted?.list({ includeDisabled: true }))?.find((item) => item.id === job.id),
          ).toBeUndefined();
        },
        { timeout: 4_000, interval: 20 },
      );

      expect(preflightCronModelProviderMock).toHaveBeenCalledTimes(2);
      const history = readCronTaskRunHistoryPage({
        storeKey: cronStoreKey(storePath),
        jobId: job.id,
        sortDir: "asc",
      }).entries;
      expect(history.map((entry) => entry.status)).toEqual(["skipped", "ok"]);
    } finally {
      first.stop();
      restarted?.stop();
    }
  });

  it("bounds unavailable time-scheduled provider retries without classifying them as errors", async () => {
    const { storePath } = await providerCronStore.makeStorePath();
    let now = Date.parse("2026-07-31T12:00:00.000Z");
    preflightCronModelProviderMock.mockResolvedValue(unavailableProviderPreflight());
    const cron = createProviderOneShotCron({ storePath, nowMs: () => now });

    try {
      await cron.start();
      const job = await cron.add({
        id: "local-provider-at-exhausted",
        name: "local provider at exhausted",
        enabled: true,
        schedule: { kind: "at", at: new Date(now + 1_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "deliver the reminder" },
        delivery: { mode: "none" },
      });
      now += 1_000;

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await expect(cron.run(job.id, "due")).resolves.toEqual({ ok: true, ran: true });
        const persisted = (await cron.list({ includeDisabled: true })).find(
          (candidate) => candidate.id === job.id,
        );
        expect(persisted?.state.consecutiveSkipped).toBe(attempt);
        expect(persisted?.state.consecutiveErrors).toBe(0);
        if (attempt < 4) {
          expect(persisted?.enabled).toBe(true);
          expect(persisted?.state.nextRunAtMs).toBe(now + 300_000);
          now = persisted?.state.nextRunAtMs ?? now;
        } else {
          expect(persisted?.enabled).toBe(false);
          expect(persisted?.state.nextRunAtMs).toBeUndefined();
          expect(persisted?.state.lastError).toContain("local provider preflight failed");
        }
      }

      expect(preflightCronModelProviderMock).toHaveBeenCalledTimes(4);
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(
        readCronTaskRunHistoryPage({ storeKey: cronStoreKey(storePath), jobId: job.id }).entries,
      ).toHaveLength(4);
    } finally {
      cron.stop();
    }
  });

  it("continues with configured fallback when the local primary preflight is unavailable", async () => {
    mockRunCronFallbackPassthrough();
    const unavailableReason =
      "Agent cron job uses ollama/qwen3:32b but the local provider preflight failed at " +
      "http://127.0.0.1:11434. The candidate is unavailable for this cron run; OpenClaw " +
      "will retry its provider preflight on a later scheduled run. Last error: " +
      "ConnectError: connect ECONNREFUSED (code=ECONNREFUSED)";
    preflightCronModelProviderMock.mockResolvedValueOnce({
      status: "unavailable",
      reason: unavailableReason,
      provider: "ollama",
      model: "qwen3:32b",
      baseUrl: "http://127.0.0.1:11434",
      retryAfterMs: 300000,
    });

    const result = await runCronIsolatedAgentTurn({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "ollama/qwen3:32b",
              fallbacks: ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", "openai/gpt-5.4"],
            },
          },
        },
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
            openrouter: {
              api: "openai-completions",
              baseUrl: "https://openrouter.ai/api/v1",
              models: [],
            },
          },
        },
      },
      deps: {} as never,
      job: {
        id: "fallback-from-dead-ollama",
        name: "Fallback From Dead Ollama",
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        state: {},
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "summarize" },
        delivery: { mode: "none" },
      },
      message: "summarize",
      sessionKey: "cron:fallback-from-dead-ollama",
      lane: "cron",
    });

    expect(result.status).toBe("ok");
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("nvidia/nemotron-3-super-120b-a12b:free");
    expect(preflightCronModelProviderMock.mock.calls.map((call) => call[0])).toMatchObject([
      { provider: "ollama", model: "qwen3:32b" },
      { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free" },
    ]);
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "openrouter",
      model: "nvidia/nemotron-3-super-120b-a12b:free",
    });
    expect(runWithModelFallbackMock.mock.calls[0]?.[0]).toMatchObject({
      fallbacksOverride: ["openai/gpt-5.4"],
    });
    const warning = String(logWarnMock.mock.calls[0]?.[0] ?? "");
    expect(warning).toContain(unavailableReason);
    expect(warning).toContain(
      "continuing with fallback openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    );
    expect(warning).not.toContain("Skipping this cron run");
  });

  it("keeps explicit empty payload fallbacks strict when local primary preflight fails", async () => {
    preflightCronModelProviderMock.mockResolvedValueOnce({
      status: "unavailable",
      reason:
        "Agent cron job uses ollama/qwen3:32b but the local provider preflight failed at http://127.0.0.1:11434.",
      provider: "ollama",
      model: "qwen3:32b",
      baseUrl: "http://127.0.0.1:11434",
      retryAfterMs: 300000,
    });

    const result = await runCronIsolatedAgentTurn({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "ollama/qwen3:32b",
              fallbacks: ["openrouter/nvidia/nemotron-3-super-120b-a12b:free"],
            },
          },
        },
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      },
      deps: {} as never,
      job: {
        id: "strict-dead-ollama",
        name: "Strict Dead Ollama",
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        state: {},
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "summarize", fallbacks: [] },
        delivery: { mode: "none" },
      },
      message: "summarize",
      sessionKey: "cron:strict-dead-ollama",
      lane: "cron",
    });

    expect(result.status).toBe("skipped");
    expect(preflightCronModelProviderMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });
});
