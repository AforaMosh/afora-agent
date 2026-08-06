import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOrResumeClientVoiceSession } from "../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../talk/client-voice-session.test-support.js";
import type { InternalRealtimeVoiceBrowserSessionCreateRequest } from "../talk/provider-internal.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { commitBrowserAllocation } from "./talk-client-browser-allocations.js";
import {
  bindBrowserSessionTerminal,
  closeBrowserAllocationForClient,
} from "./talk-client-browser-session.js";
import { cleanupTalkConnection } from "./talk-session-registry.js";

const TERMINAL_HOOK = Symbol.for("openclaw.internal.realtime-voice-browser-session-terminal.v1");
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let tempDir: string;

describe("Talk client browser session", () => {
  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-talk-browser-")));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(async () => {
    await Promise.all(
      ["conn-legacy-terminal", "conn-reopen"].map((connId) =>
        cleanupTalkConnection(connId, { warn: vi.fn() }),
      ),
    );
    clientVoiceSessionTesting.reset();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("settles a pre-adoption terminal through the real legacy allocation owner", async () => {
    const identity = {
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId: "voice-legacy-terminal",
      allocationId: "allocation-legacy-terminal",
    };
    const created = createOrResumeClientVoiceSession({
      ...identity,
      origin: "client",
      browserAllocationId: identity.allocationId,
    });
    expect(created.created).toBe(true);

    const request = {} as InternalRealtimeVoiceBrowserSessionCreateRequest;
    const terminal = bindBrowserSessionTerminal(request);
    const onTerminal = Reflect.get(request, TERMINAL_HOOK) as (outcome: {
      outcome: "completed" | "error";
      message?: string;
    }) => void;
    onTerminal({ outcome: "error", message: "sideband failed before adoption" });
    const activateEffects = vi.fn();
    const retireEffects = vi.fn();
    const cancel = vi.fn(async () => undefined);

    await expect(
      terminal.prepare({
        ...identity,
        connId: "conn-legacy-terminal",
        usesBrowserAllocations: false,
        durableState: "created",
        cancel,
        activateEffects,
        retireEffects,
        config: {},
        broadcast: vi.fn(),
        warn: vi.fn(),
      }),
    ).rejects.toThrow("sideband failed before adoption");

    expect(activateEffects).not.toHaveBeenCalled();
    expect(retireEffects).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(clientVoiceSessionTesting.readRecord("main", identity.voiceSessionId)).toMatchObject({
      status: "closed",
      browserAllocationId: identity.allocationId,
    });
  });

  it("uses reopened durable CAS when an exact close misses a live replacement owner", async () => {
    const durable = {
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId: "voice-reopen",
      allocationId: "allocation-a",
    };
    createOrResumeClientVoiceSession({
      ...durable,
      origin: "client",
      browserAllocationId: durable.allocationId,
    });
    closeOpenClawAgentDatabasesForTest();

    const request = {} as InternalRealtimeVoiceBrowserSessionCreateRequest;
    const activateEffects = vi.fn();
    const retireEffects = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const candidate = await bindBrowserSessionTerminal(request).prepare({
      ...durable,
      allocationId: "allocation-b",
      connId: "conn-reopen",
      usesBrowserAllocations: true,
      durableState: "existing",
      expectedBrowserAllocationId: durable.allocationId,
      cancel,
      activateEffects,
      retireEffects,
      config: {},
      broadcast: vi.fn(),
      warn: vi.fn(),
    });

    await closeBrowserAllocationForClient({
      ...durable,
      allocationId: "allocation-c",
      connId: "conn-close",
      config: {},
    });
    expect(clientVoiceSessionTesting.readRecord("main", durable.voiceSessionId)).toMatchObject({
      status: "open",
      browserAllocationId: durable.allocationId,
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(activateEffects).not.toHaveBeenCalled();

    closeOpenClawAgentDatabasesForTest();
    await closeBrowserAllocationForClient({
      ...durable,
      connId: "conn-close",
      config: {},
    });
    expect(clientVoiceSessionTesting.readRecord("main", durable.voiceSessionId)).toMatchObject({
      status: "closed",
      browserAllocationId: durable.allocationId,
    });
    expect(() => commitBrowserAllocation(candidate)).toThrow("already closed");
    expect(activateEffects).not.toHaveBeenCalled();

    await cleanupTalkConnection("conn-reopen", { warn: vi.fn() });
    expect(cancel).toHaveBeenCalledOnce();
    expect(retireEffects).toHaveBeenCalledOnce();
  });
});
