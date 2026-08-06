// Gateway Protocol tests cover channels.schema behavior.
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
  ChannelsStatusResultSchema,
  TalkClientAllocationAbortedResultSchema,
  TalkClientAllocationCommittedResultSchema,
  TalkClientAllocationMutationResultSchema,
  TalkClientAllocationTerminalResultSchema,
  TalkClientAllocationTerminalEventSchema,
  TalkClientAllocationParamsSchema,
  TalkClientCreateResultSchema,
  TalkClientMutationResultSchema,
  WebLoginWaitParamsSchema,
} from "./schema/channels.js";

/**
 * Channel schema regressions for browser login and status diagnostics.
 * These payloads are consumed by dashboard/operator UI, so QR payload bounds
 * and event-loop diagnostic shape are part of the public gateway contract.
 */

describe("WebLoginWaitParamsSchema", () => {
  /** Compiled validator reused across QR bounds cases. */
  const validate = Compile(WebLoginWaitParamsSchema);

  it("bounds caller-provided QR data URLs", () => {
    expect(
      validate.Check({
        currentQrDataUrl: "data:image/png;base64,qr",
      }),
    ).toBe(true);

    expect(
      validate.Check({
        currentQrDataUrl: "x".repeat(16_385),
      }),
    ).toBe(false);
    expect(
      validate.Check({
        currentQrDataUrl: "https://example.com/qr.png",
      }),
    ).toBe(false);
  });
});

describe("ChannelsStatusResultSchema", () => {
  /** Compiled status validator for channel docking diagnostics. */
  const validate = Compile(ChannelsStatusResultSchema);

  it("accepts gateway event-loop diagnostics emitted by channels.status", () => {
    expect(
      validate.Check({
        ts: Date.now(),
        channelOrder: ["discord"],
        channelLabels: { discord: "Discord" },
        channels: { discord: { configured: true } },
        channelAccounts: {
          discord: [
            {
              accountId: "default",
              enabled: true,
              configured: true,
              running: true,
              connected: false,
              healthState: "stale-socket",
              lastError: null,
              lastStartAt: null,
              lastStopAt: null,
              lastInboundAt: null,
              lastOutboundAt: null,
              credentialSource: "service-account",
              audienceType: "app-url",
              audience: "https://chat.example.test",
              webhookPath: "/googlechat",
              webhookUrl: null,
            },
          ],
        },
        channelDefaultAccountId: { discord: "default" },
        partial: true,
        warnings: ["discord:default probe timed out after 1000ms"],
        eventLoop: {
          degraded: true,
          degradedSinceMs: 61_000,
          reasons: ["event_loop_delay", "cpu"],
          intervalMs: 62_000,
          delayP99Ms: 1_250.5,
          delayMaxMs: 62_000,
          utilization: 0.98,
          cpuCoreRatio: 1.2,
        },
      }),
    ).toBe(true);
  });
});

describe("Talk client browser allocations", () => {
  const validateMutation = Compile(TalkClientAllocationParamsSchema);
  const validateCreate = Compile(TalkClientCreateResultSchema);
  const validateCommittedResult = Compile(TalkClientAllocationCommittedResultSchema);
  const validateAbortedResult = Compile(TalkClientAllocationAbortedResultSchema);
  const validateTerminalResult = Compile(TalkClientAllocationTerminalResultSchema);
  const validateAllocationResult = Compile(TalkClientAllocationMutationResultSchema);
  const validateMutationResult = Compile(TalkClientMutationResultSchema);
  const validateTerminal = Compile(TalkClientAllocationTerminalEventSchema);

  it("accepts bounded opaque allocation ids and lifecycle outcomes", () => {
    expect(
      validateMutation.Check({
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-1",
        allocationId: "allocation_1",
      }),
    ).toBe(true);
    expect(
      validateCreate.Check({
        provider: "openai",
        transport: "webrtc",
        voiceSessionId: "voice-1",
        allocationId: "allocation_1",
        clientSecret: "secret",
      }),
    ).toBe(true);
    expect(validateMutationResult.Check({ ok: true })).toBe(true);
    expect(validateCommittedResult.Check({ state: "committed" })).toBe(true);
    expect(validateAbortedResult.Check({ state: "aborted" })).toBe(true);
    expect(
      validateTerminalResult.Check({
        state: "terminal",
        terminal: { outcome: "error", message: "sideband failed" },
      }),
    ).toBe(true);
    expect(validateAllocationResult.Check({ state: "committed" })).toBe(true);
    expect(validateAllocationResult.Check({ state: "aborted" })).toBe(true);
    expect(validateAllocationResult.Check({ ok: true })).toBe(false);
    expect(
      validateAllocationResult.Check({
        state: "terminal",
        terminal: { outcome: "error", message: "sideband failed" },
      }),
    ).toBe(true);
    expect(
      validateTerminal.Check({
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-1",
        allocationId: "allocation_1",
        outcome: "error",
        message: "sideband failed",
      }),
    ).toBe(true);
    expect(
      validateMutation.Check({
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-1",
        allocationId: "bad:id",
      }),
    ).toBe(false);
    expect(
      validateCreate.Check({
        provider: "openai",
        transport: "webrtc",
        voiceSessionId: "voice-1",
        allocationId: "allocation_1",
        clientSecret: "secret",
        terminal: { outcome: "error", message: "sideband failed" },
      }),
    ).toBe(true);
  });
});
