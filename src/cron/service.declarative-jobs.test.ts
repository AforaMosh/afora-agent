import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import type { CronAddResult } from "./service/state.js";
import { loadCronStore } from "./store.js";
import type { CronJob, CronJobCreate } from "./types.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-declarative-" });
installCronTestHooks({ logger });

function createCronService(storePath: string, cronEnabled = true, triggersEnabled = false) {
  return new CronService({
    storePath,
    cronEnabled,
    ...(triggersEnabled ? { cronConfig: { triggers: { enabled: true } } } : {}),
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

function declaration(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "daily report",
    declarationKey: "agent:ops:daily-report",
    displayName: "Daily report",
    owner: { agentId: "ops", sessionKey: "agent:ops:main" },
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "report" },
    delivery: { mode: "announce", channel: "last" },
    ...overrides,
  };
}

function declarativeResult(result: CronAddResult) {
  if (!("job" in result)) {
    throw new Error("expected declarative cron result");
  }
  return result;
}

describe("CronService declarative jobs", () => {
  it.each([
    { kind: "every" as const, everyMs: 60_000 },
    { kind: "cron" as const, expr: "0 * * * *" },
  ])(
    "clears scheduler-owned recovery state when an auto-disabled $kind job becomes a stream",
    async (schedule) => {
      const { storePath } = await makeStorePath();
      const now = Date.now();
      await writeCronStoreSnapshot({
        storePath,
        jobs: [
          {
            ...declaration({ schedule }),
            id: "auto-disabled-declaration",
            enabled: false,
            createdAtMs: now - 60_000,
            updatedAtMs: now - 1_000,
            state: {
              lastRunAtMs: now - 2_000,
              lastRunStatus: "error",
              lastError: "preserve the last execution failure",
              consecutiveErrors: 10,
              scheduleErrorCount: 3,
              autoDisabled: {
                reason: "consecutive-failures",
                atMs: now - 1_000,
                consecutiveErrors: 10,
              },
            },
          },
        ],
      });
      const cron = createCronService(storePath, true, true);
      await cron.start();

      try {
        const result = declarativeResult(
          await cron.add(
            declaration({ schedule: { kind: "stream", command: ["node", "events.mjs"] } }),
            { enabledExplicit: true },
          ),
        );
        expect(result).toMatchObject({ created: false, updated: true, enabled: true });
        expect(result.job.state).toMatchObject({
          lastRunAtMs: now - 2_000,
          lastRunStatus: "error",
          lastError: "preserve the last execution failure",
          consecutiveErrors: 0,
          scheduleErrorCount: 0,
          streamConsecutiveFailures: 0,
        });
        expect(result.job.state.autoDisabled).toBeUndefined();
        expect(result.job.state.streamRestartExhausted).toBeUndefined();
        const persisted = (await loadCronStore(storePath)).jobs[0];
        expect(persisted?.state.autoDisabled).toBeUndefined();
        expect(persisted?.state.consecutiveErrors).toBe(0);
        expect(persisted?.state.scheduleErrorCount).toBe(0);
      } finally {
        cron.stop();
      }
    },
  );

  it.each([
    { label: "already-enabled", enabled: true },
    { label: "disabled", enabled: false },
  ])(
    "persists explicit recovery of a $label exhausted stream with an identical declaration",
    async ({ enabled }) => {
      const { storePath } = await makeStorePath();
      const now = Date.now();
      const streamDeclaration = declaration({
        schedule: { kind: "stream", command: ["node", "events.mjs"] },
      });
      await writeCronStoreSnapshot({
        storePath,
        jobs: [
          {
            ...streamDeclaration,
            id: "exhausted-stream-declaration",
            enabled,
            createdAtMs: now - 60_000,
            updatedAtMs: now - 1_000,
            state: {
              lastRunAtMs: now - 2_000,
              lastRunStatus: "error",
              lastError: "preserve the failed source history",
              consecutiveErrors: 5,
              streamStatus: "error",
              streamError: "stream source exited (exit, code 1)",
              streamConsecutiveFailures: 5,
              streamRestartExhausted: true,
            },
          },
        ],
      });
      const cron = createCronService(storePath, true, true);
      await cron.start();

      try {
        const omittedEnable = declarativeResult(await cron.add(streamDeclaration));
        expect(omittedEnable).toMatchObject({ created: false, updated: false });
        expect(omittedEnable.job.state.streamRestartExhausted).toBe(true);

        const recovered = declarativeResult(
          await cron.add(streamDeclaration, { enabledExplicit: true }),
        );
        expect(recovered).toMatchObject({ created: false, updated: true, enabled: true });
        expect(recovered.job.state).toMatchObject({
          lastRunAtMs: now - 2_000,
          lastRunStatus: "error",
          lastError: "preserve the failed source history",
          consecutiveErrors: 0,
          scheduleErrorCount: 0,
          streamConsecutiveFailures: 0,
        });
        expect(recovered.job.state.streamError).toBeUndefined();
        expect(recovered.job.state.streamRestartExhausted).toBeUndefined();
        const persisted = (await loadCronStore(storePath)).jobs[0];
        expect(persisted?.state.streamRestartExhausted).toBeUndefined();
        expect(persisted?.state.streamError).toBeUndefined();
        expect(persisted?.state.streamConsecutiveFailures).toBe(0);

        const healthyNoop = declarativeResult(
          await cron.add(streamDeclaration, { enabledExplicit: true }),
        );
        expect(healthyNoop).toMatchObject({ created: false, updated: false });
      } finally {
        cron.stop();
      }
    },
  );

  it.each([
    { label: "unchanged enabled", storedEnabled: true, configuredEnabled: true, updated: false },
    { label: "configured re-enable", storedEnabled: false, configuredEnabled: true, updated: true },
    { label: "configured disable", storedEnabled: true, configuredEnabled: false, updated: true },
  ])(
    "preserves scheduler failure state for $label system-owned heartbeat convergence",
    async ({ storedEnabled, configuredEnabled, updated }) => {
      const { storePath } = await makeStorePath();
      const now = Date.now();
      const heartbeat = declaration({
        declarationKey: "heartbeat:main",
        name: "heartbeat-main",
        displayName: "Heartbeat (main)",
        agentId: "main",
        enabled: configuredEnabled,
        owner: undefined,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
        sessionTarget: "main",
        payload: { kind: "heartbeat" },
        delivery: undefined,
      });
      const autoDisabled = !storedEnabled
        ? { reason: "consecutive-failures" as const, atMs: now - 1_000, consecutiveErrors: 10 }
        : undefined;
      await writeCronStoreSnapshot({
        storePath,
        jobs: [
          {
            ...heartbeat,
            id: "heartbeat-main",
            enabled: storedEnabled,
            createdAtMs: now - 60_000,
            updatedAtMs: now - 1_000,
            state: {
              consecutiveErrors: 4,
              scheduleErrorCount: 2,
              ...(autoDisabled ? { autoDisabled } : {}),
            },
          },
        ],
      });
      const cron = createCronService(storePath);

      try {
        const converged = declarativeResult(
          await cron.add(heartbeat, { enabledExplicit: true, systemOwned: true }),
        );
        expect(converged).toMatchObject({
          created: false,
          updated,
          enabled: configuredEnabled,
        });
        expect(converged.job.state).toMatchObject({
          consecutiveErrors: 4,
          scheduleErrorCount: 2,
          ...(autoDisabled ? { autoDisabled } : {}),
        });
        expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
          consecutiveErrors: 4,
          scheduleErrorCount: 2,
          ...(autoDisabled ? { autoDisabled } : {}),
        });
      } finally {
        cron.stop();
      }
    },
  );

  it("creates, no-ops, and converges in place while preserving state and enablement", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const created = declarativeResult(
        await cron.add(declaration({ declarationKey: "  agent:ops:daily-report  " }), {
          enabledExplicit: true,
        }),
      );
      expect(created.created).toBe(true);
      expect(created).not.toHaveProperty("updated");
      expect(created.job).toMatchObject({
        declarationKey: "agent:ops:daily-report",
        displayName: "Daily report",
        owner: { agentId: "ops", sessionKey: "agent:ops:main" },
        payload: { toolsAllow: ["*"] },
      });

      const identical = declarativeResult(await cron.add(declaration(), { enabledExplicit: true }));
      expect(identical).toMatchObject({
        created: false,
        updated: false,
        id: created.id,
      });

      await cron.update(created.id, {
        enabled: false,
        state: {
          lastRunAtMs: 1234,
          lastRunStatus: "error",
          lastError: "previous failure",
        },
      });
      const converged = declarativeResult(
        await cron.add(
          declaration({
            displayName: "Daily summary",
            schedule: { kind: "every", everyMs: 120_000 },
            payload: { kind: "agentTurn", message: "summarize" },
            delivery: { mode: "none" },
          }),
          { enabledExplicit: false },
        ),
      );
      expect(converged).toMatchObject({ created: false, updated: true, id: created.id });
      expect(converged.job).toMatchObject({
        id: created.id,
        displayName: "Daily summary",
        enabled: false,
        schedule: { kind: "every", everyMs: 120_000 },
        payload: { kind: "agentTurn", message: "summarize" },
        delivery: { mode: "none" },
        state: {
          lastRunAtMs: 1234,
          lastRunStatus: "error",
          lastError: "previous failure",
        },
      });

      const explicitlyEnabled = declarativeResult(
        await cron.add(
          declaration({
            displayName: "Daily summary",
            enabled: true,
            schedule: { kind: "every", everyMs: 120_000 },
            payload: { kind: "agentTurn", message: "summarize" },
            delivery: { mode: "none" },
          }),
          { enabledExplicit: true },
        ),
      );
      expect(explicitlyEnabled).toMatchObject({
        created: false,
        updated: true,
        id: created.id,
        enabled: true,
      });
      const cleared = await cron.update(created.id, { displayName: null });
      expect(cleared).not.toHaveProperty("displayName");
    } finally {
      cron.stop();
    }
  });

  it("keeps declaration-key uniqueness local to the caller visibility predicate", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const key = "shared-key";
      const agentA = declarativeResult(
        await cron.add(declaration({ declarationKey: key, owner: { agentId: "alpha" } }), {
          matchesExisting: (job) => job.owner?.agentId === "alpha",
        }),
      );
      const agentB = declarativeResult(
        await cron.add(declaration({ declarationKey: key, owner: { agentId: "beta" } }), {
          matchesExisting: (job) => job.owner?.agentId === "beta",
        }),
      );
      expect(agentB.id).not.toBe(agentA.id);
      await expect(cron.add(declaration({ declarationKey: key }))).rejects.toThrow(
        "ambiguous within caller scope",
      );

      const agentAUpdate = declarativeResult(
        await cron.add(
          declaration({
            declarationKey: key,
            displayName: "Alpha report",
            owner: { agentId: "alpha" },
          }),
          { matchesExisting: (job) => job.owner?.agentId === "alpha" },
        ),
      );
      expect(agentAUpdate).toMatchObject({
        created: false,
        updated: true,
        id: agentA.id,
        displayName: "Alpha report",
      });
      expect(await cron.list()).toHaveLength(2);
    } finally {
      cron.stop();
    }
  });

  it("checks update preconditions under the mutation lock", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const created = declarativeResult(await cron.add(declaration()));
      await expect(
        cron.updateWithPrecondition(created.id, { displayName: "Blocked" }, () => {
          throw new Error("scope changed");
        }),
      ).rejects.toThrow("scope changed");
      expect(await cron.readJob(created.id)).toMatchObject({ displayName: "Daily report" });
    } finally {
      cron.stop();
    }
  });

  it("converges delivery while retaining the declared session target", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const created = await cron.add(
        declaration({
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "wake" },
          delivery: undefined,
        }),
      );
      // Session target is identity-adjacent and stays outside declaration
      // convergence; delivery converges, and main + webhook is a supported
      // shipped combination.
      const converged = await cron.add(
        declaration({
          sessionTarget: "isolated",
          payload: { kind: "systemEvent", text: "wake" },
          delivery: { mode: "webhook", to: "https://example.invalid/hook" },
        }),
      );
      expect(converged).toMatchObject({ created: false, updated: true });
      expect(await cron.readJob(created.id)).toMatchObject({
        sessionTarget: "main",
        delivery: { mode: "webhook", to: "https://example.invalid/hook" },
      });
    } finally {
      cron.stop();
    }
  });

  it("persists declaration metadata and rejects blank or duplicate reserved ids", async () => {
    const { storePath } = await makeStorePath();
    const writer = createCronService(storePath);
    await writer.start();
    const created = declarativeResult(
      await writer.add(declaration({ id: "reserved-id" }), { enabledExplicit: true }),
    );
    await expect(writer.add(declaration({ declarationKey: undefined, id: "  " }))).rejects.toThrow(
      "id must not be blank",
    );
    await expect(
      writer.add(declaration({ declarationKey: undefined, id: created.id })),
    ).rejects.toThrow("already exists");
    await expect(writer.add(declaration({ displayName: "   " }))).rejects.toThrow(
      "displayName must not be blank",
    );
    await expect(writer.update(created.id, { displayName: "   " })).rejects.toThrow(
      "displayName must not be blank",
    );
    for (const id of ["nested/job", "..\\job", "nul\0job"]) {
      await expect(writer.add(declaration({ declarationKey: undefined, id }))).rejects.toThrow(
        "invalid cron task run job id",
      );
    }
    writer.stop();

    const reader = createCronService(storePath, false);
    const persisted = await reader.readJob(created.id);
    expect(persisted).toMatchObject({
      declarationKey: "agent:ops:daily-report",
      displayName: "Daily report",
      owner: { agentId: "ops", sessionKey: "agent:ops:main" },
    } satisfies Partial<CronJob>);
  });
});
