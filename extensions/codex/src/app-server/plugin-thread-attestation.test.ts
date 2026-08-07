import { describe, expect, it, vi } from "vitest";
import {
  attestCodexPluginThreadApps,
  discardUnattestedCodexPluginThread,
} from "./plugin-thread-attestation.js";
import type { v2 } from "./protocol.js";

describe("Codex plugin thread app attestation", () => {
  it("reads the committed snapshot with the started thread's effective policy", async () => {
    const request = vi.fn(async () => installedApps(["linear-app"]));

    await attestCodexPluginThreadApps({
      client: { request } as never,
      threadId: "thread-linear",
      appIds: ["linear-app", "linear-app"],
    });

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "app/installed",
      { threadId: "thread-linear", forceRefresh: false },
      { signal: undefined },
    );
  });

  it("attests configured plugin and account apps against one thread snapshot", async () => {
    const request = vi.fn(async () => installedApps(["plugin-app", "account-app"]));

    await attestCodexPluginThreadApps({
      client: { request } as never,
      threadId: "thread-mixed-apps",
      appIds: ["plugin-app", "account-app", "plugin-app"],
    });

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "app/installed",
      { threadId: "thread-mixed-apps", forceRefresh: false },
      { signal: undefined },
    );
  });

  it("rejects a mixed snapshot when the thread denies its account-wide app", async () => {
    const request = vi.fn(async () => installedApps(["plugin-app"]));

    await expect(
      attestCodexPluginThreadApps({
        client: { request } as never,
        threadId: "thread-mixed-apps",
        appIds: ["plugin-app", "account-app"],
      }),
    ).rejects.toMatchObject({
      name: "CodexPluginThreadAppAttestationError",
      message: expect.stringContaining("account-app:missing"),
    });

    expect(request).toHaveBeenCalledOnce();
  });

  it("does not read the app snapshot when no apps need attestation", async () => {
    const request = vi.fn();

    await attestCodexPluginThreadApps({
      client: { request } as never,
      threadId: "thread-linear",
      appIds: [],
    });

    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    {
      state: "missing",
      response: installedApps([]),
      failure: "linear-app:missing",
    },
    {
      state: "disabled",
      response: installedApps(["linear-app"], { enabled: false, callable: false }),
      failure: "linear-app:disabled",
    },
    {
      state: "not callable",
      response: installedApps(["linear-app"], { callable: false }),
      failure: "linear-app:not-callable",
    },
  ])("fails closed when an admitted app is $state", async ({ response, failure }) => {
    await expect(
      attestCodexPluginThreadApps({
        client: { request: vi.fn(async () => response) } as never,
        threadId: "thread-linear",
        appIds: ["linear-app"],
      }),
    ).rejects.toMatchObject({
      name: "CodexPluginThreadAppAttestationError",
      message: expect.stringContaining(failure),
    });
  });

  it("preserves the original cause when thread-scoped discovery fails", async () => {
    const cause = new Error("committed app snapshot unavailable");

    await expect(
      attestCodexPluginThreadApps({
        client: {
          request: vi.fn(async () => {
            throw cause;
          }),
        } as never,
        threadId: "thread-linear",
        appIds: ["linear-app"],
      }),
    ).rejects.toMatchObject({
      name: "CodexPluginThreadAppAttestationError",
      cause,
    });
  });
});

describe("unattested Codex plugin thread cleanup", () => {
  it("deletes a persistent thread before its first rollout", async () => {
    const request = vi.fn(async (method: string) =>
      method === "thread/list" ? { data: [], nextCursor: null } : {},
    );

    await expect(
      discardUnattestedCodexPluginThread({
        client: { request } as never,
        threadId: "thread-persistent",
        ephemeral: false,
      }),
    ).resolves.toBe(true);

    expect(request).toHaveBeenNthCalledWith(
      1,
      "thread/list",
      {
        ancestorThreadId: "thread-persistent",
        archived: false,
        limit: 100,
        sortKey: "created_at",
        sortDirection: "desc",
        useStateDbOnly: true,
      },
      { timeoutMs: 5_000 },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "thread/list",
      {
        ancestorThreadId: "thread-persistent",
        archived: true,
        limit: 100,
        sortKey: "created_at",
        sortDirection: "desc",
        useStateDbOnly: true,
      },
      { timeoutMs: 5_000 },
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "thread/delete",
      { threadId: "thread-persistent" },
      { timeoutMs: 5_000 },
    );
  });

  it("unsubscribes an ephemeral thread that Codex cannot delete", async () => {
    const request = vi.fn(async () => ({}));

    await expect(
      discardUnattestedCodexPluginThread({
        client: { request } as never,
        threadId: "thread-ephemeral",
        ephemeral: true,
      }),
    ).resolves.toBe(true);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "thread/unsubscribe",
      { threadId: "thread-ephemeral" },
      { timeoutMs: 5_000 },
    );
  });

  it("does not treat unsubscribe as proof that a persistent thread was deleted", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "thread/list") {
        return { data: [], nextCursor: null };
      }
      if (method === "thread/delete") {
        throw new Error("thread deletion unavailable");
      }
      return {};
    });

    await expect(
      discardUnattestedCodexPluginThread({
        client: { request } as never,
        threadId: "thread-persistent",
        ephemeral: false,
      }),
    ).resolves.toBe(false);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/list",
      "thread/list",
      "thread/delete",
      "thread/unsubscribe",
    ]);
  });

  it("preserves a persistent thread when Codex reports a spawned descendant", async () => {
    const request = vi.fn(async (method: string) =>
      method === "thread/list" ? { data: [{ id: "thread-user-branch" }], nextCursor: null } : {},
    );

    await expect(
      discardUnattestedCodexPluginThread({
        client: { request } as never,
        threadId: "thread-persistent",
        ephemeral: false,
      }),
    ).resolves.toBe(false);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/list",
      "thread/unsubscribe",
    ]);
  });

  it("preserves a persistent thread when only an archived descendant remains", async () => {
    const request = vi.fn(async (method: string, params?: { archived?: boolean }) =>
      method === "thread/list"
        ? params?.archived
          ? { data: [{ id: "thread-archived-branch" }], nextCursor: null }
          : { data: [], nextCursor: null }
        : {},
    );

    await expect(
      discardUnattestedCodexPluginThread({
        client: { request } as never,
        threadId: "thread-persistent",
        ephemeral: false,
      }),
    ).resolves.toBe(false);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/list",
      "thread/list",
      "thread/unsubscribe",
    ]);
  });
});

function installedApps(
  appIds: string[],
  state: { enabled?: boolean; callable?: boolean } = {},
): v2.AppsInstalledResponse {
  return {
    apps: appIds.map((id) => ({
      id,
      runtimeName: id,
      enabled: state.enabled ?? true,
      callable: state.callable ?? true,
    })),
  };
}
