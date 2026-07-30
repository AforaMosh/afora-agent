import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitAgentAuditEvent,
  emitAgentEvent,
  registerAgentRunContext,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import { SessionService } from "../sessions/session-service.js";
import { openClawRuntime } from "./openclaw-runtime.js";

describe("openClawRuntime", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  it("exposes the canonical session service", () => {
    expect(openClawRuntime.sessions).toBeInstanceOf(SessionService);
  });

  it("synchronously forwards enriched agent turn observations", () => {
    registerAgentRunContext("run-1", {
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      agentId: "main",
      isControlUiVisible: false,
    });
    const observer = vi.fn();
    const unsubscribe = openClawRuntime.observeAgentTurns(observer);

    emitAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });

    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        seq: 1,
        stream: "lifecycle",
        sessionKey: "agent:main:main",
        sessionId: "session-1",
        agentId: "main",
        controlUiVisible: false,
        data: { phase: "start", startedAt: 1_000 },
      }),
    );
    unsubscribe();
  });

  it("stops forwarding after unsubscribe", () => {
    const observer = vi.fn();
    const unsubscribe = openClawRuntime.observeAgentTurns(observer);

    unsubscribe();
    emitAgentEvent({
      runId: "run-unsubscribed",
      stream: "assistant",
      data: { text: "ignored" },
    });

    expect(observer).not.toHaveBeenCalled();
  });

  it("does not expose private audit-only events", () => {
    const observer = vi.fn();
    const unsubscribe = openClawRuntime.observeAgentTurns(observer);

    emitAgentAuditEvent({
      runId: "audit-only-run",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });

    expect(observer).not.toHaveBeenCalled();
    unsubscribe();
  });
});
