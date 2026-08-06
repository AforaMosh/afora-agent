import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  normalizeSessionDeliveryState,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { deliverClientVoiceMutationDigest } from "./client-voice-mutation-digest-owner.js";
import {
  closeClientVoiceSession,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

type SendDurableMessageBatchParams = Parameters<
  (typeof import("../channels/message/runtime.js"))["sendDurableMessageBatch"]
>[0];

const { sendDurableMessageBatch } = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(async (_params: SendDurableMessageBatchParams) => ({
    status: "sent",
  })),
}));

vi.mock("../channels/message/runtime.js", () => ({ sendDurableMessageBatch }));

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let tempDir: string;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function seedSession(sessionKey: string, context: DeliveryContext = {}): Promise<void> {
  await replaceSessionEntry(
    { agentId: "main", sessionKey },
    {
      sessionId: `session-${sessionKey.replaceAll(":", "-")}`,
      updatedAt: Date.now(),
      delivery: normalizeSessionDeliveryState({ context }),
    },
  );
}

function recordMutation(voiceSessionId: string, runId = `run-${voiceSessionId}`): void {
  registerClientVoiceConsultRun({
    agentId: "main",
    sessionKey: "agent:main:main",
    voiceSessionId,
    runId,
  });
  emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    runId,
    toolCallId: `call-${runId}`,
    toolName: "message",
    mutatingAction: true,
  });
  emitTrustedDiagnosticEvent({
    type: "tool.execution.completed",
    runId,
    toolCallId: `call-${runId}`,
    toolName: "message",
    durationMs: 5,
  });
}

async function completeRun(runId: string): Promise<void> {
  emitTrustedDiagnosticEvent({
    type: "run.completed",
    runId,
    durationMs: 5,
    outcome: "completed",
  });
  await waitForDiagnosticEventsDrained();
}

describe("client voice session digest retry", () => {
  beforeEach(async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-digest-retry-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    sendDurableMessageBatch.mockReset().mockResolvedValue({ status: "sent" });
  });

  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("records post-close effects and defers the digest until the last consult completes", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    for (const runId of ["run-1", "run-2"]) {
      registerClientVoiceConsultRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        runId,
      });
    }

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();

    for (const runId of ["run-1", "run-2"]) {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        runId,
        toolCallId: `call-${runId}`,
        toolName: "message",
        mutatingAction: true,
      });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.completed",
        runId,
        toolCallId: `call-${runId}`,
        toolName: "message",
        durationMs: 5,
      });
    }
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects).toEqual([
      expect.objectContaining({ runId: "run-1", status: "succeeded" }),
      expect.objectContaining({ runId: "run-2", status: "succeeded" }),
    ]);

    await completeRun("run-1");
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
    await completeRun("run-2");
    await vi.waitFor(() => expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1));
    expect(sendDurableMessageBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "Voice call changes\n- message: succeeded\n- message: succeeded" }],
      }),
    );
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt).toEqual(
      expect.any(Number),
    );

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
  });

  it("preserves an effect appended while a digest send is blocked", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    recordMutation(voiceSessionId, "run-first");
    await completeRun("run-first");
    const blockedSend = deferred<{ status: "sent" }>();
    sendDurableMessageBatch.mockImplementationOnce(() => blockedSend.promise);

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    await vi.waitFor(() => expect(sendDurableMessageBatch).toHaveBeenCalledOnce());

    registerClientVoiceConsultRun({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      runId: "run-late",
      config: {},
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-late",
      toolCallId: "call-late",
      toolName: "write",
      mutatingAction: true,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "run-late",
      toolCallId: "call-late",
      toolName: "write",
      durationMs: 5,
    });
    await completeRun("run-late");
    blockedSend.resolve({ status: "sent" });

    await vi.waitFor(() => expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2));
    expect(sendDurableMessageBatch.mock.calls.map((call) => call[0].payloads)).toEqual([
      [{ text: "Voice call changes\n- message: succeeded" }],
      [{ text: "Voice call changes\n- write: succeeded" }],
    ]);
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
      digestDeliveredRevision: 4,
      nextEffectRevision: 5,
    });
  });

  it("delivers more than twelve effects in exact revision batches", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    registerClientVoiceConsultRun({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      runId: "run-batch",
    });
    for (let index = 1; index <= 13; index += 1) {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        runId: "run-batch",
        toolCallId: `call-${index}`,
        toolName: `tool-${index}`,
        mutatingAction: true,
      });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.completed",
        runId: "run-batch",
        toolCallId: `call-${index}`,
        toolName: `tool-${index}`,
        durationMs: 5,
      });
    }
    await completeRun("run-batch");

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });

    await vi.waitFor(() => expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2));
    const texts = sendDurableMessageBatch.mock.calls.map((call) => call[0].payloads[0]?.text);
    expect(texts[0]?.split("\n")).toHaveLength(13);
    expect(texts[0]).toContain("- tool-1: succeeded");
    expect(texts[0]).toContain("- tool-12: succeeded");
    expect(texts[0]).not.toContain("- tool-13: succeeded");
    expect(texts[1]).toBe("Voice call changes\n- tool-13: succeeded");
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
      digestDeliveredRevision: 26,
      nextEffectRevision: 27,
    });
  });

  it("redelivers an effect whose terminal status has a newer revision", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    registerClientVoiceConsultRun({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      runId: "run-update",
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-update",
      toolCallId: "call-update",
      toolName: "message",
      mutatingAction: true,
    });
    const started = clientVoiceSessionTesting.readRecord("main", voiceSessionId);
    if (!started) {
      throw new Error("voice session record was not created");
    }
    expect(started?.effects[0]?.revision).toBe(1);
    expect(await deliverClientVoiceMutationDigest(started, {}, new AbortController().signal)).toBe(
      "complete",
    );

    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "run-update",
      toolCallId: "call-update",
      toolName: "message",
      durationMs: 5,
    });
    const completed = clientVoiceSessionTesting.readRecord("main", voiceSessionId);
    if (!completed) {
      throw new Error("voice session record was not persisted");
    }
    expect(completed).toMatchObject({
      digestDeliveredRevision: 1,
      nextEffectRevision: 3,
      effects: [{ status: "succeeded", revision: 2 }],
    });
    expect(
      await deliverClientVoiceMutationDigest(completed, {}, new AbortController().signal),
    ).toBe("complete");
    expect(sendDurableMessageBatch.mock.calls.map((call) => call[0].payloads)).toEqual([
      [{ text: "Voice call changes\n- message: outcome not confirmed" }],
      [{ text: "Voice call changes\n- message: succeeded" }],
    ]);
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredRevision,
    ).toBe(2);
    await completeRun("run-update");
  });

  it("retries a deferred digest on the next lifecycle trigger after run completion", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    registerClientVoiceConsultRun({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      runId: "run-live",
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-live",
      toolCallId: "call-run-live",
      toolName: "message",
      mutatingAction: true,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "run-live",
      toolCallId: "call-run-live",
      toolName: "message",
      durationMs: 5,
    });
    // Call ends while the consult still runs, so the digest is deferred.
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    sendDurableMessageBatch.mockRejectedValueOnce(new Error("channel offline"));
    await completeRun("run-live");
    await vi.waitFor(() =>
      expect(clientVoiceSessionTesting.digestDeliverySnapshot().active).toBe(0),
    );
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
    ).toBeUndefined();

    await closeStaleClientVoiceSessions({ agentId: "main", config: {} });
    await vi.waitFor(() =>
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
      ).toEqual(expect.any(Number)),
    );
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
  });

  it("retries the mutation digest after a transient close-time send failure", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    recordMutation(voiceSessionId);
    await completeRun(`run-${voiceSessionId}`);
    sendDurableMessageBatch.mockRejectedValueOnce(new Error("channel offline"));

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    await vi.waitFor(() =>
      expect(clientVoiceSessionTesting.digestDeliverySnapshot().active).toBe(0),
    );
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
    ).toBeUndefined();

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    await vi.waitFor(() =>
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
      ).toEqual(expect.any(Number)),
    );
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed digest while a late consult owns the retry", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    recordMutation(voiceSessionId);
    await completeRun(`run-${voiceSessionId}`);
    sendDurableMessageBatch.mockRejectedValueOnce(new Error("channel offline"));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await closeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        config: {},
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
        active: 0,
        pending: 0,
        retained: 1,
      });

      registerClientVoiceConsultRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        runId: "late-run",
        config: {},
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(
        clientVoiceSessionTesting.digestDeliveryPolicy.failureRetentionMs + 1,
      );
      expect(clientVoiceSessionTesting.digestDeliverySnapshot().retained).toBe(1);

      recordMutation(voiceSessionId, "late-run");
      await completeRun("late-run");
      await vi.advanceTimersByTimeAsync(0);
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
      ).toEqual(expect.any(Number));
      expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers one mutation digest and skips webchat or missing targets", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const delivered = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    recordMutation(delivered);
    await completeRun(`run-${delivered}`);
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId: delivered,
      config: {},
    });
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId: delivered,
      config: {},
    });
    await vi.waitFor(() => expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1));
    expect(sendDurableMessageBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        durability: "required",
        requireUnknownSendReconciliation: true,
        payloads: [{ text: "Voice call changes\n- message: succeeded" }],
      }),
    );

    for (const [voiceSessionId, route] of [
      ["voice-webchat", { channel: "webchat", to: "browser" }],
      ["voice-no-target", {}],
    ] as const) {
      const sessionKey = `agent:main:${voiceSessionId}`;
      await seedSession(sessionKey, route);
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
        voiceSessionId,
      });
      registerClientVoiceConsultRun({
        agentId: "main",
        sessionKey,
        voiceSessionId,
        runId: `run-${voiceSessionId}`,
      });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        runId: `run-${voiceSessionId}`,
        toolCallId: `call-${voiceSessionId}`,
        toolName: "message",
        mutatingAction: true,
      });
      await completeRun(`run-${voiceSessionId}`);
      await closeClientVoiceSession({
        agentId: "main",
        sessionKey,
        voiceSessionId,
        config: {},
      });
    }
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
  });
});
