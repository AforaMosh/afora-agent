/**
 * Tests bounded transcript-flush probing before reusing CLI bindings, and the
 * stop reason a delivered CLI failure settles on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agent-run-terminal-outcome.js";
import {
  isCliBindingFlushed,
  restoreCliRunnerTestDeps,
  setCliRunnerTestDeps,
} from "../cli-runner.js";
import { buildCliDeliveredFailure } from "./cli-run-settlement.js";
import { attachCliMessagingDeliveryEvidence } from "./delivery-evidence.js";
import { createCliTimeoutError } from "./no-output-timeout-policy.js";
import type { PreparedCliRunContext } from "./types.js";

describe("isCliBindingFlushed", () => {
  const workspaceDir = "/tmp/afora-workspace";

  beforeEach(() => {
    vi.useRealTimers();
    restoreCliRunnerTestDeps();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    restoreCliRunnerTestDeps();
  });

  it("returns false when no sessionId is provided", async () => {
    const probe = vi.fn(async () => true);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed(undefined, "claude-cli")).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true when the transcript has content on the first probe", async () => {
    const probe = vi.fn(async () => true);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-fresh", "claude-cli", workspaceDir)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith({ sessionId: "sid-fresh", workspaceDir });
  });

  it("retries up to three times before giving up", async () => {
    const delay = vi.fn(async () => undefined);
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe, delay });

    expect(await isCliBindingFlushed("sid-cold", "claude-cli", workspaceDir)).toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenNthCalledWith(1, 50);
    expect(delay).toHaveBeenNthCalledWith(2, 150);
  });

  it("succeeds when the transcript becomes visible on a later retry", async () => {
    const delay = vi.fn(async () => undefined);
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      return calls >= 2;
    });
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe, delay });

    expect(await isCliBindingFlushed("sid-late", "claude-cli", workspaceDir)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledExactlyOnceWith(50);
  });

  it("schedules at most 0 + 50 + 150ms of delay across the bounded retry", async () => {
    vi.useFakeTimers();
    try {
      // Fake timers enforce the retry contract without introducing wall-clock
      // sleeps into this import-heavy agent test.
      const probe = vi.fn(async () => false);
      setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

      const settled = vi.fn();
      const errored = vi.fn();
      isCliBindingFlushed("sid-bounded", "claude-cli", workspaceDir).then(settled, errored);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(150);

      expect(settled).toHaveBeenCalledTimes(1);
      expect(settled.mock.calls[0]?.[0]).toBe(false);
      expect(errored).not.toHaveBeenCalled();
      expect(probe).toHaveBeenCalledTimes(3);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("returns true without probing for non-claude-cli providers", async () => {
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-codex", "codex-cli")).toBe(true);
    expect(await isCliBindingFlushed("sid-anthropic", "anthropic")).toBe(true);
    expect(await isCliBindingFlushed("sid-openai", "openai")).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true without probing when provider is undefined", async () => {
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-x", undefined)).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true without probing when the caller owns continuity outside native transcripts", async () => {
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(
      await isCliBindingFlushed("sid-warm", "claude-cli", workspaceDir, {
        skipTranscriptProbe: true,
      }),
    ).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("still probes when transcript-probe skipping is disabled", async () => {
    const probe = vi.fn(async () => true);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(
      await isCliBindingFlushed("sid-probe", "claude-cli", workspaceDir, {
        skipTranscriptProbe: false,
      }),
    ).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("buildCliDeliveredFailure", () => {
  const timeoutContext = {
    mode: "no-output" as const,
    timeoutSeconds: 600,
    observedActivity: true,
    activeToolCount: 1,
    backgroundTaskCount: 0,
  };

  function buildContext(): PreparedCliRunContext {
    return {
      params: {
        provider: "claude-cli",
        model: "sonnet-4.6",
        runId: "run-timeout",
        agentId: "main",
        sessionKey: "agent:main:subagent:child",
        prompt: "run the long job",
      },
      started: Date.now() - 1_000,
      modelId: "sonnet-4.6",
      systemPromptReport: undefined,
    } as unknown as PreparedCliRunContext;
  }

  function settle(error: unknown, evidence: Record<string, unknown>) {
    return buildCliDeliveredFailure({
      error,
      evidence: evidence as never,
      context: buildContext(),
      preparedContextAgentMeta: {},
      sessionBindingDisabled: false,
    });
  }

  const progressEvidence = {
    didSendViaMessagingTool: true,
    messagingToolSentTexts: ["Ran 12 lanes; 3 still failing."],
    messagingToolSourceReplyPayloads: [
      { text: "Ran 12 lanes; 3 still failing.", sourceReplyFinal: false },
    ],
  };

  it("settles a no-output watchdog kill that already delivered progress as a timeout", () => {
    const error = createCliTimeoutError(
      { provider: "claude-cli", model: "sonnet-4.6" },
      timeoutContext,
      "cli_no_output_timeout",
    );

    const result = settle(error, progressEvidence);

    expect(result.meta.stopReason).toBe("timeout");
    expect(result.meta.completion?.stopReason).toBe("timeout");
    // The brief keeps finishReason out of scope: it only feeds the trace block.
    expect(result.meta.completion?.finishReason).toBe("error");
    expect(result.payloads?.map((payload) => payload.text)).toContain(
      "Ran 12 lanes; 3 still failing.",
    );
  });

  it("settles a watchdog kill with no delivered progress as a timeout too", () => {
    const error = createCliTimeoutError(
      { provider: "claude-cli", model: "sonnet-4.6" },
      { ...timeoutContext, mode: "overall" },
    );

    const result = settle(error, { didSendViaMessagingTool: true });

    expect(result.meta.stopReason).toBe("timeout");
    expect(result.meta.completion?.stopReason).toBe("timeout");
    expect(result.meta.completion?.finishReason).toBe("error");
  });

  it("sees the timeout through the non-extensible delivery-evidence wrapper", () => {
    const frozen = Object.freeze(
      createCliTimeoutError({ provider: "claude-cli", model: "sonnet-4.6" }, timeoutContext),
    );
    const wrapped = attachCliMessagingDeliveryEvidence(frozen, {
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["Ran 12 lanes; 3 still failing."],
    });
    // The wrapper is a plain Error, so only a cause walk can still classify it.
    expect(wrapped).not.toBe(frozen);

    expect(settle(wrapped, progressEvidence).meta.stopReason).toBe("timeout");
  });

  it("still settles a genuine crash as an error", () => {
    const result = settle(new Error("boom"), progressEvidence);

    expect(result.meta.stopReason).toBe("error");
    expect(result.meta.completion?.stopReason).toBe("error");
    expect(result.meta.completion?.finishReason).toBe("error");
  });

  it("carries the settled stop reason into the terminal status agent.wait reports", () => {
    const timedOut = settle(
      createCliTimeoutError({ provider: "claude-cli", model: "sonnet-4.6" }, timeoutContext),
      progressEvidence,
    );
    const crashed = settle(new Error("boom"), progressEvidence);

    // agent-job feeds meta.stopReason into this builder to answer agent.wait,
    // and the subagent announce path only preserves partial output on "timeout".
    expect(
      buildAgentRunTerminalOutcomeFromLifecycleEvent({
        phase: "end",
        data: { stopReason: timedOut.meta.stopReason },
      }).status,
    ).toBe("timeout");
    expect(
      buildAgentRunTerminalOutcomeFromLifecycleEvent({
        phase: "end",
        data: { stopReason: crashed.meta.stopReason },
      }).status,
    ).toBe("error");
  });
});
