import type { registerNativeHookRelay } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexNativeHookRelay } from "./native-hook-relay.js";
import {
  clearCodexNativeHookRelayOwners,
  codexNativeHookRelayOwnerCount,
} from "./native-hook-relay.test-harness.js";

type ActiveNativeHookRelayHandle = ReturnType<typeof registerNativeHookRelay>;

const relayCapture = vi.hoisted(() => ({
  handles: [] as ActiveNativeHookRelayHandle[],
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    registerNativeHookRelay: (params: Parameters<typeof actual.registerNativeHookRelay>[0]) => {
      const handle = actual.registerNativeHookRelay(params);
      relayCapture.handles.push(handle);
      return handle;
    },
  };
});

type BridgeRow = {
  relay_id: string;
  pid: number;
  hostname: string;
  port: number;
  token: string;
  expires_at_ms: number;
  updated_at_ms: number;
};

let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    applyEnv: true,
    label: "codex-native-hook-relay-renewal",
  });
});

afterEach(async () => {
  clearCodexNativeHookRelayOwners();
  for (const handle of relayCapture.handles) {
    handle.unregister();
  }
  relayCapture.handles.length = 0;
  closeOpenClawStateDatabaseForTest();
  testState.restoreEnv();
  await testState.cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createRoute(generation: string) {
  const acquisition = createCodexNativeHookRelay({
    options: { enabled: true, ttlMs: 1_000 },
    generation,
    events: ["pre_tool_use"],
    agentId: "main",
    sessionId: `session-${generation}`,
    sessionKey: `agent:main:session-${generation}`,
    config: undefined,
    runId: `run-${generation}`,
    attemptTimeoutMs: 1_000,
    startupTimeoutMs: 1_000,
    turnStartTimeoutMs: 1_000,
    loopDetectionPreToolUseRelay: true,
    signal: new AbortController().signal,
    onPreToolUseFailure: vi.fn(),
  });
  return acquisition.status === "active" ? acquisition.lease : undefined;
}

function readBridge(relayId: string): BridgeRow | undefined {
  return openOpenClawStateDatabase()
    .db.prepare("SELECT * FROM native_hook_relay_bridges WHERE relay_id = ?")
    .get(relayId) as BridgeRow | undefined;
}

async function waitForBridge(relayId: string): Promise<BridgeRow> {
  let record: BridgeRow | undefined;
  await vi.waitFor(() => {
    record = readBridge(relayId);
    expect(record?.port).toBeGreaterThan(0);
  });
  if (!record) {
    throw new Error(`Expected bridge record for ${relayId}`);
  }
  return record;
}

function replaceWithForeignBridge(params: {
  relayId: string;
  nowMs: number;
  expiresAtMs: number;
}): BridgeRow {
  const database = openOpenClawStateDatabase();
  database.db
    .prepare(
      `UPDATE native_hook_relay_bridges
       SET pid = ?, hostname = ?, port = ?, token = ?, expires_at_ms = ?, updated_at_ms = ?
       WHERE relay_id = ?`,
    )
    .run(
      process.pid + 10_000,
      "127.0.0.1",
      9,
      "foreign-owner-token",
      params.expiresAtMs,
      params.nowMs,
      params.relayId,
    );
  const record = readBridge(params.relayId);
  if (!record) {
    throw new Error(`Expected foreign bridge record for ${params.relayId}`);
  }
  return record;
}

describe("Codex native hook relay SQLite renewal recovery", () => {
  it("recovers the same route and bridge after renewal uncertainty crosses expiry", async () => {
    const relay = createRoute("same-owner-recovery");
    expect(relay).toBeDefined();
    const handle = relayCapture.handles[0];
    if (!handle) {
      throw new Error("Expected captured native hook relay handle");
    }
    const before = await waitForBridge(handle.relayId);
    let nowMs = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const authoritativeRenew = handle.renewStatus.bind(handle);
    vi.spyOn(handle, "renewStatus")
      .mockReturnValueOnce("unknown")
      .mockImplementation((ttlMs) => authoritativeRenew(ttlMs));

    relay?.renew(20_000);
    nowMs = before.expires_at_ms + 1;

    await vi.waitFor(
      () => {
        const after = readBridge(handle.relayId);
        expect(after?.expires_at_ms).toBeGreaterThan(before.expires_at_ms);
      },
      { timeout: 3_000 },
    );
    const after = readBridge(handle.relayId);
    expect(after).toMatchObject({
      relay_id: before.relay_id,
      pid: before.pid,
      port: before.port,
      token: before.token,
    });
    expect(handle.generation).toBe("same-owner-recovery");
    expect(relayCapture.handles).toHaveLength(1);
    expect(codexNativeHookRelayOwnerCount()).toBe(1);
    relay?.releaseParent();
  });

  it("preserves a foreign takeover and retires the route without policy ownership", async () => {
    const relay = createRoute("foreign-takeover");
    expect(relay).toBeDefined();
    const handle = relayCapture.handles[0];
    if (!handle) {
      throw new Error("Expected captured native hook relay handle");
    }
    const before = await waitForBridge(handle.relayId);
    let nowMs = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const authoritativeRenew = handle.renewStatus.bind(handle);
    vi.spyOn(handle, "renewStatus")
      .mockReturnValueOnce("unknown")
      .mockImplementation((ttlMs) => authoritativeRenew(ttlMs));

    relay?.renew(20_000);
    nowMs = before.expires_at_ms + 1;
    const foreign = replaceWithForeignBridge({
      relayId: handle.relayId,
      nowMs,
      expiresAtMs: nowMs + 60_000,
    });

    await vi.waitFor(() => expect(codexNativeHookRelayOwnerCount()).toBe(0), { timeout: 3_000 });
    expect(readBridge(handle.relayId)).toStrictEqual(foreign);
    expect(relayCapture.handles).toHaveLength(1);
    expect(handle.renewStatus(20_000)).toBe("dead");
    expect(handle.rebindAttempt?.({ runId: "must-not-run-policy" })).toBe(false);
  });
});
