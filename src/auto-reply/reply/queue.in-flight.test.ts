// Proves queue caps and depth describe pending work while active identities remain in shared state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  getFollowupQueueDepth,
  scheduleFollowupDrain,
} from "./queue.js";
import { createQueueTestRun as createRun } from "./queue.test-helpers.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import type { FollowupRun, QueueDropPolicy, QueueSettings } from "./queue/types.js";

describe("followup queue in-flight ownership", () => {
  const keys = new Set<string>();

  afterEach(() => {
    for (const key of keys) {
      clearFollowupQueue(key);
    }
    keys.clear();
  });

  const createKey = (suffix: string) => {
    const key = `test-in-flight-${suffix}-${Date.now()}-${Math.random()}`;
    keys.add(key);
    return key;
  };

  const createSettings = (dropPolicy: QueueDropPolicy): QueueSettings => ({
    mode: "followup",
    debounceMs: 0,
    cap: 1,
    dropPolicy,
  });

  it.each(["old", "summarize"] as const)(
    "keeps an active single delivery out of %s overflow victims",
    async (dropPolicy) => {
      const key = createKey(dropPolicy);
      const entered = createDeferred();
      const release = createDeferred();
      const activeComplete = vi.fn();
      const pendingComplete = vi.fn();
      const calls: FollowupRun[] = [];
      const active = {
        ...createRun({ prompt: "active" }),
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: activeComplete },
      };
      const runFollowup = async (run: FollowupRun) => {
        calls.push(run);
        await run.turnAdoptionLifecycle?.onAdopted?.();
        if (run === active) {
          entered.resolve();
          await release.promise;
        }
        completeFollowupRunLifecycle(run);
      };

      try {
        expect(
          enqueueFollowupRun(key, active, createSettings(dropPolicy), "none", runFollowup),
        ).toBe(true);
        await entered.promise;

        expect(getFollowupQueueDepth(key)).toBe(0);
        expect(
          enqueueFollowupRun(
            key,
            {
              ...createRun({ prompt: "pending" }),
              turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: pendingComplete },
            },
            createSettings(dropPolicy),
            "none",
          ),
        ).toBe(true);
        expect(
          enqueueFollowupRun(
            key,
            createRun({ prompt: "survivor" }),
            createSettings(dropPolicy),
            "none",
          ),
        ).toBe(true);

        const queue = getExistingFollowupQueue(key);
        expect(queue?.inFlight.has(active)).toBe(true);
        expect(queue?.items.map((item) => item.prompt)).toEqual(["active", "survivor"]);
        expect(getFollowupQueueDepth(key)).toBe(1);
        expect(activeComplete).not.toHaveBeenCalled();
        expect(pendingComplete).toHaveBeenCalledTimes(dropPolicy === "old" ? 1 : 0);
        expect(queue?.summarySources.map((item) => item.prompt)).toEqual(
          dropPolicy === "summarize" ? ["pending"] : [],
        );
      } finally {
        release.resolve();
      }

      await expect.poll(() => getExistingFollowupQueue(key)).toBeUndefined();
      expect(activeComplete).toHaveBeenCalledOnce();
      expect(pendingComplete).toHaveBeenCalledOnce();
      expect(calls.at(-1)?.prompt).toBe("survivor");
    },
  );

  it("admits one pending item under drop:new while another item is active", async () => {
    const key = createKey("new");
    const entered = createDeferred();
    const release = createDeferred();
    const rejectedEnqueued = vi.fn();
    const rejectedComplete = vi.fn();
    const active = createRun({ prompt: "active" });
    const runFollowup = async (run: FollowupRun) => {
      await run.turnAdoptionLifecycle?.onAdopted?.();
      if (run === active) {
        entered.resolve();
        await release.promise;
      }
      completeFollowupRunLifecycle(run);
    };

    try {
      expect(enqueueFollowupRun(key, active, createSettings("new"), "none", runFollowup)).toBe(
        true,
      );
      await entered.promise;

      expect(getFollowupQueueDepth(key)).toBe(0);
      expect(
        enqueueFollowupRun(key, createRun({ prompt: "pending" }), createSettings("new"), "none"),
      ).toBe(true);
      expect(
        enqueueFollowupRun(
          key,
          {
            ...createRun({ prompt: "rejected" }),
            turnAdoptionLifecycle: {
              onAdopted: async () => {},
              onDeferred: rejectedEnqueued,
              onSettled: rejectedComplete,
            },
          },
          createSettings("new"),
          "none",
        ),
      ).toBe(false);

      expect(getFollowupQueueDepth(key)).toBe(1);
      expect(getExistingFollowupQueue(key)?.items.map((item) => item.prompt)).toEqual([
        "active",
        "pending",
      ]);
      expect(rejectedEnqueued).not.toHaveBeenCalled();
      expect(rejectedComplete).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
    }

    await expect.poll(() => getExistingFollowupQueue(key)).toBeUndefined();
  });

  it("keeps mixed-origin delivery callbacks on their queued sources", async () => {
    const key = createKey("mixed-origin-source");
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "old",
    };
    const webChatDelivery = vi.fn(async () => {});
    const laterDiscordDelivery = vi.fn(async () => {});
    const webChatRun = {
      ...createRun({
        prompt: "webchat reply",
        originatingChannel: "webchat",
      }),
      queuedFollowupReplyDisposition: { kind: "deliver" as const, deliver: webChatDelivery },
    };
    const discordRun = {
      ...createRun({
        prompt: "discord reply",
        originatingChannel: "discord",
      }),
      queuedFollowupReplyDisposition: {
        kind: "deliver" as const,
        deliver: laterDiscordDelivery,
      },
    };
    const latestRunner = async (run: FollowupRun) => {
      if (run.queuedFollowupReplyDisposition?.kind === "deliver") {
        await run.queuedFollowupReplyDisposition.deliver({
          kind: "queued-followup",
          runId: `${run.prompt}-run`,
          originatingChannel: run.originatingChannel,
          payloads: [{ text: run.prompt }],
        });
      }
      completeFollowupRunLifecycle(run);
    };

    expect(enqueueFollowupRun(key, webChatRun, settings, "none", undefined, false)).toBe(true);
    expect(enqueueFollowupRun(key, discordRun, settings, "none", latestRunner, false)).toBe(true);
    scheduleFollowupDrain(key, latestRunner);

    await expect.poll(() => getExistingFollowupQueue(key)).toBeUndefined();
    expect(webChatDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        originatingChannel: "webchat",
        payloads: [{ text: "webchat reply" }],
      }),
    );
    expect(laterDiscordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        originatingChannel: "discord",
        payloads: [{ text: "discord reply" }],
      }),
    );
    expect(laterDiscordDelivery).not.toHaveBeenCalledWith(
      expect.objectContaining({ payloads: [{ text: "webchat reply" }] }),
    );
  });

  it("protects a collect group and counts only active identities still present", async () => {
    const key = createKey("collect");
    const entered = createDeferred();
    const release = createDeferred();
    const groupCompletions = [vi.fn(), vi.fn()];
    const groupDeliveryCallbacks = [vi.fn(async () => {}), undefined];
    const pendingComplete = vi.fn();
    const rejectedComplete = vi.fn();
    let aggregate: FollowupRun | undefined;
    const initialSettings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };
    const group = groupCompletions.map((onComplete, index) => ({
      ...createRun({
        prompt: `group-${index + 1}`,
        originatingChannel: "slack" as const,
        originatingTo: "channel:A",
        originatingChatType: "channel",
      }),
      turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
      queuedFollowupReplyDisposition: groupDeliveryCallbacks[index]
        ? { kind: "deliver" as const, deliver: groupDeliveryCallbacks[index] }
        : { kind: "drop" as const, reason: "source-unavailable" as const },
    }));
    const runFollowup = async (run: FollowupRun) => {
      if (!aggregate) {
        aggregate = run;
        entered.resolve();
        await release.promise;
      }
      completeFollowupRunLifecycle(run);
    };

    for (const run of group) {
      expect(enqueueFollowupRun(key, run, initialSettings, "none", undefined, false)).toBe(true);
    }
    scheduleFollowupDrain(key, runFollowup);

    try {
      await entered.promise;
      const queue = getExistingFollowupQueue(key);
      expect(queue?.inFlight.size).toBe(2);
      expect(getFollowupQueueDepth(key)).toBe(0);
      expect(aggregate?.queuedFollowupReplyDisposition).toEqual({
        kind: "drop",
        reason: "source-unavailable",
      });

      const oldSettings: QueueSettings = { ...initialSettings, cap: 1, dropPolicy: "old" };
      expect(
        enqueueFollowupRun(
          key,
          {
            ...createRun({ prompt: "pending-old" }),
            turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: pendingComplete },
          },
          oldSettings,
          "none",
        ),
      ).toBe(true);
      expect(enqueueFollowupRun(key, createRun({ prompt: "survivor" }), oldSettings, "none")).toBe(
        true,
      );

      expect(queue?.items.map((item) => item.prompt)).toEqual(["group-1", "group-2", "survivor"]);
      expect(pendingComplete).toHaveBeenCalledOnce();
      expect(groupCompletions.map((complete) => complete.mock.calls.length)).toEqual([0, 0]);

      await aggregate?.turnAdoptionLifecycle?.onAdopted?.();
      expect(queue?.items.map((item) => item.prompt)).toEqual(["survivor"]);
      expect(queue?.inFlight.size).toBe(2);
      expect(getFollowupQueueDepth(key)).toBe(1);

      expect(
        enqueueFollowupRun(
          key,
          {
            ...createRun({ prompt: "rejected-new" }),
            turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: rejectedComplete },
          },
          { ...initialSettings, cap: 1, dropPolicy: "new" },
          "none",
        ),
      ).toBe(false);
      expect(rejectedComplete).toHaveBeenCalledOnce();
      expect(getFollowupQueueDepth(key)).toBe(1);
    } finally {
      release.resolve();
    }

    await expect.poll(() => getExistingFollowupQueue(key)).toBeUndefined();
    expect(groupCompletions.map((complete) => complete.mock.calls.length)).toEqual([1, 1]);
  });
});
