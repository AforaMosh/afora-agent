// Session resolve tests cover canonical/legacy key lookup, store migration,
// agent scoping, visibility, and domain error mapping.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";

const hoisted = vi.hoisted(() => ({
  canonicalizeSessionEntryAliasesMock: vi.fn(),
  resolveSessionStoreTargetWithStoreMock: vi.fn(),
  loadCombinedSessionStoreMock: vi.fn(),
  listAgentIdsMock: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/agent-scope.js")>(
    "../agents/agent-scope.js",
  );
  return {
    ...actual,
    listAgentIds: hoisted.listAgentIdsMock,
  };
});

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    canonicalizeSessionEntryAliases: hoisted.canonicalizeSessionEntryAliasesMock,
  };
});

vi.mock("./session-combined-store.js", () => ({
  loadCombinedSessionStore: hoisted.loadCombinedSessionStoreMock,
}));

vi.mock("./session-store-target.js", () => ({
  resolveSessionStoreTargetWithStore: hoisted.resolveSessionStoreTargetWithStoreMock,
}));

const { resolveSessionSelector } = await import("./session-resolve.js");

describe("resolveSessionSelector", () => {
  const canonicalKey = "agent:main:canon";
  const legacyKey = "agent:main:legacy";
  const storePath = "/tmp/sessions.json";
  let targetStore: Record<string, SessionEntry>;

  const expectResolveToCanonicalKey = async (
    selector: Parameters<typeof resolveSessionSelector>[0]["selector"],
  ) => {
    await expect(
      resolveSessionSelector({
        config: {},
        selector,
      }),
    ).resolves.toEqual({
      ok: true,
      value: { key: canonicalKey },
    });
  };

  beforeEach(() => {
    hoisted.canonicalizeSessionEntryAliasesMock.mockReset();
    hoisted.resolveSessionStoreTargetWithStoreMock.mockReset();
    hoisted.loadCombinedSessionStoreMock.mockReset();
    hoisted.listAgentIdsMock.mockReset();
    targetStore = {};
    // Default: all agents are known (main is always present).
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);
    hoisted.resolveSessionStoreTargetWithStoreMock.mockImplementation(() => ({
      canonicalKey,
      storeKeys: [canonicalKey, legacyKey],
      storePath,
      store: targetStore,
    }));
    hoisted.canonicalizeSessionEntryAliasesMock.mockImplementation(async () => {
      const entry = expectDefined(
        targetStore[legacyKey] ?? targetStore[canonicalKey],
        "canonical session entry",
      );
      targetStore[canonicalKey] = entry;
      delete targetStore[legacyKey];
      return { canonicalKey, entry };
    });
  });

  it("hides canonical keys that fail the spawnedBy visibility filter", async () => {
    targetStore = {
      [canonicalKey]: { sessionId: "sess-1", updatedAt: 1 },
    };
    await expect(
      resolveSessionSelector({
        config: {},
        selector: { key: canonicalKey, spawnedBy: "controller-1" },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "not-found",
        message: `No session found: ${canonicalKey}`,
      },
    });
  });

  it("does not page-limit exact key spawnedBy visibility checks", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      [canonicalKey]: {
        sessionId: "sess-target",
        spawnedBy: "controller-1",
        updatedAt: now - 10_000,
      },
    };
    for (let i = 0; i < 120; i += 1) {
      store[`agent:main:sibling-${i}`] = {
        sessionId: `sess-sibling-${i}`,
        spawnedBy: "controller-1",
        updatedAt: now - i,
      };
    }
    targetStore = store;

    await expectResolveToCanonicalKey({ key: canonicalKey, spawnedBy: "controller-1" });
  });

  it("re-checks migrated legacy keys through the same visibility filter", async () => {
    const store = {
      [legacyKey]: { sessionId: "sess-legacy", spawnedBy: "controller-1", updatedAt: Date.now() },
    } satisfies Record<string, SessionEntry>;
    targetStore = store;

    await expectResolveToCanonicalKey({ key: canonicalKey, spawnedBy: "controller-1" });

    expect(hoisted.canonicalizeSessionEntryAliasesMock).toHaveBeenCalledTimes(1);
    expect(hoisted.canonicalizeSessionEntryAliasesMock).toHaveBeenCalledWith({
      storePath,
      target: {
        canonicalKey,
        storeKeys: [canonicalKey, legacyKey],
      },
    });
  });

  it("does not let allowMissing mask a deleted-agent error", async () => {
    const deletedAgentKey = "agent:deleted-agent:main";
    targetStore = {
      [deletedAgentKey]: { sessionId: "sess-orphan", updatedAt: 1 },
    };
    hoisted.resolveSessionStoreTargetWithStoreMock.mockReturnValue({
      canonicalKey: deletedAgentKey,
      storeKeys: [deletedAgentKey],
      storePath,
      store: targetStore,
    });
    // "deleted-agent" is not in the known agents list.
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);

    const result = await resolveSessionSelector({
      config: {},
      selector: { key: deletedAgentKey, allowMissing: true },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "agent-not-found",
        message: 'Agent "deleted-agent" no longer exists in configuration',
      },
    });
  });

  it("resolves ACP harness session keys even when harness id is not in agents.list", async () => {
    const acpKey = "agent:claude:acp:11111111-1111-4111-8111-111111111111";
    targetStore = {
      [acpKey]: {
        sessionId: "sess-acp",
        updatedAt: 1,
        label: "claude-delegate-test",
        acp: {
          backend: "acpx",
          agent: "claude",
          runtimeSessionName: acpKey,
          mode: "oneshot",
          state: "idle",
          lastActivityAt: 1,
        },
      },
    };
    hoisted.resolveSessionStoreTargetWithStoreMock.mockReturnValue({
      canonicalKey: acpKey,
      storeKeys: [acpKey],
      storePath,
      store: targetStore,
    });
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);

    await expect(
      resolveSessionSelector({
        config: {},
        selector: { key: acpKey },
      }),
    ).resolves.toEqual({
      ok: true,
      value: { key: acpKey },
    });
  });

  it("rejects non-alias agent:main sessions when main is no longer configured", async () => {
    const staleMainKey = "agent:main:guildchat:direct:u1";
    targetStore = {
      [staleMainKey]: { sessionId: "sess-stale-main", updatedAt: 1 },
    };
    hoisted.resolveSessionStoreTargetWithStoreMock.mockReturnValue({
      canonicalKey: staleMainKey,
      storeKeys: [staleMainKey],
      storePath,
      store: targetStore,
    });
    hoisted.listAgentIdsMock.mockReturnValue(["ops"]);

    const result = await resolveSessionSelector({
      config: { agents: { list: [{ id: "ops", default: true }] } },
      selector: { key: staleMainKey },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "agent-not-found",
        message: 'Agent "main" no longer exists in configuration',
      },
    });
  });

  it("rejects sessions belonging to a deleted agent (sessionId-based lookup)", async () => {
    const deletedAgentKey = "agent:deleted-agent:main";
    hoisted.loadCombinedSessionStoreMock.mockReturnValue({
      storePath,
      store: { [deletedAgentKey]: { sessionId: "sess-orphan", updatedAt: 1 } },
    });
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);

    const result = await resolveSessionSelector({
      config: {},
      selector: { sessionId: "sess-orphan" },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "agent-not-found",
        message: 'Agent "deleted-agent" no longer exists in configuration',
      },
    });
  });

  it("resolves sessionId matches from raw store metadata without hydrating session rows", async () => {
    hoisted.loadCombinedSessionStoreMock.mockReturnValue({
      storePath,
      store: {
        "agent:main:noisy": { sessionId: "sess-noisy", updatedAt: 2 },
        "agent:main:target": { sessionId: "sess-target", updatedAt: 1 },
      },
    });
    const cfg = {};
    const result = await resolveSessionSelector({
      config: cfg,
      selector: { sessionId: "sess-target", agentId: "main" },
    });

    expect(result).toEqual({ ok: true, value: { key: "agent:main:target" } });
    expect(hoisted.loadCombinedSessionStoreMock).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
  });

  it("excludes archived sessions from sessionId and label resolution", async () => {
    hoisted.loadCombinedSessionStoreMock.mockReturnValue({
      storePath,
      store: {
        "agent:main:archived": {
          sessionId: "sess-shared",
          label: "shared-label",
          updatedAt: 2,
          archivedAt: 2,
        },
        "agent:main:active": {
          sessionId: "sess-shared",
          label: "shared-label",
          updatedAt: 1,
        },
      },
    });

    await expect(
      resolveSessionSelector({
        config: {},
        selector: { sessionId: "sess-shared" },
      }),
    ).resolves.toEqual({ ok: true, value: { key: "agent:main:active" } });
    await expect(
      resolveSessionSelector({
        config: {},
        selector: { label: "shared-label" },
      }),
    ).resolves.toEqual({ ok: true, value: { key: "agent:main:active" } });
  });

  it("rejects sessions belonging to a deleted agent (label-based lookup)", async () => {
    const deletedAgentKey = "agent:deleted-agent:main";
    hoisted.loadCombinedSessionStoreMock.mockReturnValue({
      storePath,
      store: { [deletedAgentKey]: { sessionId: "sess-orphan", updatedAt: 1, label: "my-label" } },
    });
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);

    const cfg = {};
    const result = await resolveSessionSelector({
      config: cfg,
      selector: { label: "my-label" },
    });

    expect(hoisted.loadCombinedSessionStoreMock).toHaveBeenCalledWith(cfg, {
      agentId: undefined,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "agent-not-found",
        message: 'Agent "deleted-agent" no longer exists in configuration',
      },
    });
  });
});
