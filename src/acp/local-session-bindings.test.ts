import { describe, expect, it } from "vitest";
import { AcpLocalSessionBindings } from "./local-session-bindings.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("AcpLocalSessionBindings", () => {
  it("keeps forward and reverse indexes consistent across replacement and removal", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "acp-1",
      sessionKey: "agent:main:first",
      cwd: "/work/first",
    });
    await bindings.replace({
      sessionId: "acp-2",
      sessionKey: "agent:main:first",
      cwd: "/work/second",
    });

    await bindings.replace({
      sessionId: "acp-1",
      sessionKey: "agent:main:next",
      cwd: "/work/next",
    });

    expect(bindings.listBySessionKey("agent:main:first").map((entry) => entry.sessionId)).toEqual([
      "acp-2",
    ]);
    expect(bindings.listBySessionKey("agent:main:next").map((entry) => entry.sessionId)).toEqual([
      "acp-1",
    ]);
    await expect(bindings.remove("acp-1")).resolves.toMatchObject({
      sessionKey: "agent:main:next",
    });
    expect(bindings.get("acp-1")).toBeUndefined();
    expect(bindings.listBySessionKey("agent:main:next")).toEqual([]);
    expect(bindings.list().map((entry) => entry.sessionId)).toEqual(["acp-2"]);
  });

  it("returns immutable binding snapshots", async () => {
    const bindings = new AcpLocalSessionBindings();
    const binding = await bindings.replace({
      sessionId: "acp-1",
      sessionKey: "agent:main:one",
      cwd: "/work",
      runtimeOptions: {
        thinking: "high",
        backendExtras: { verbose: "full" },
      },
    });

    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.runtimeOptions)).toBe(true);
    expect(Object.isFrozen(binding.runtimeOptions?.backendExtras)).toBe(true);
    expect(() => {
      (binding as { cwd: string }).cwd = "/changed";
    }).toThrow();
    expect(bindings.get("acp-1")?.cwd).toBe("/work");
  });

  it("exposes siblings and applies canonical lifecycle mutation atomically", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "acp-1",
      sessionKey: "agent:main:shared",
      cwd: "/one",
    });
    await bindings.replace({
      sessionId: "acp-2",
      sessionKey: "agent:main:shared",
      cwd: "/two",
    });
    const observed: string[] = [];

    await bindings.runCanonicalLifecycle({
      sessionId: "acp-1",
      sessionKey: "agent:main:shared",
      operation: async ({ siblings, remove, replace }) => {
        observed.push(...siblings.map((binding) => binding.sessionId));
        for (const sibling of siblings) {
          remove(sibling.sessionId);
        }
        replace({
          sessionId: "acp-1",
          sessionKey: "agent:main:shared",
          cwd: "/reset",
        });
      },
    });

    expect(observed).toEqual(["acp-1", "acp-2"]);
    expect(bindings.get("acp-2")).toBeUndefined();
    expect(bindings.get("acp-1")?.cwd).toBe("/reset");
  });

  it("serializes lifecycle work for the same canonical key", async () => {
    const bindings = new AcpLocalSessionBindings();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];

    const first = bindings.runCanonicalLifecycle({
      sessionId: "acp-1",
      sessionKey: "agent:main:shared",
      operation: async () => {
        order.push("first:start");
        firstStarted.resolve();
        await releaseFirst.promise;
        order.push("first:end");
      },
    });
    await firstStarted.promise;
    const second = bindings.runCanonicalLifecycle({
      sessionId: "acp-2",
      sessionKey: "agent:main:shared",
      operation: async () => {
        order.push("second");
      },
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("allows independent canonical keys to progress concurrently", async () => {
    const bindings = new AcpLocalSessionBindings();
    const releaseFirst = deferred<void>();
    let secondCompleted = false;

    const first = bindings.runCanonicalLifecycle({
      sessionId: "acp-1",
      sessionKey: "agent:main:first",
      operation: async () => {
        await releaseFirst.promise;
      },
    });
    const second = bindings.runCanonicalLifecycle({
      sessionId: "acp-2",
      sessionKey: "agent:main:second",
      operation: async () => {
        secondCompleted = true;
      },
    });

    await second;
    expect(secondCompleted).toBe(true);
    releaseFirst.resolve();
    await first;
  });

  it("resolves an omitted canonical key after queued rebinding", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "acp-1",
      sessionKey: "agent:main:old",
      cwd: "/old",
    });
    const rebindStarted = deferred<void>();
    const releaseRebind = deferred<void>();
    const rebinding = bindings.runCanonicalLifecycle({
      sessionId: "acp-1",
      sessionKey: "agent:main:new",
      operation: async ({ replace }) => {
        rebindStarted.resolve();
        await releaseRebind.promise;
        replace({
          sessionId: "acp-1",
          sessionKey: "agent:main:new",
          cwd: "/new",
        });
      },
    });
    await rebindStarted.promise;

    const observing = bindings.runCanonicalLifecycle({
      sessionId: "acp-1",
      operation: async ({ current, siblings }) => ({
        current,
        siblings,
      }),
    });
    releaseRebind.resolve();
    await rebinding;

    await expect(observing).resolves.toMatchObject({
      current: {
        sessionKey: "agent:main:new",
        cwd: "/new",
      },
      siblings: [{ sessionKey: "agent:main:new" }],
    });
  });

  it("rejects lifecycle mutators retained after the lock scope ends", async () => {
    const bindings = new AcpLocalSessionBindings();
    let staleRemove!: (sessionId: string) => unknown;
    await bindings.runCanonicalLifecycle({
      sessionId: "acp-1",
      sessionKey: "agent:main:one",
      operation: async ({ remove, replace }) => {
        replace({
          sessionId: "acp-1",
          sessionKey: "agent:main:one",
          cwd: "/work",
        });
        staleRemove = remove;
      },
    });

    expect(() => staleRemove("acp-1")).toThrow("ACP lifecycle mutation scope has ended");
    expect(bindings.get("acp-1")).toBeDefined();
  });
});
