// Slack plugin module implements slash harness behavior.
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import { setSlackRuntime } from "../runtime.js";

type AsyncMock = ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;

const mocks = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  turnPlanMock: vi.fn(),
  readAllowFromStoreMock: vi.fn(),
  upsertPairingRequestMock: vi.fn(),
  resolveAgentRouteMock: vi.fn(),
  buildContextMock: vi.fn(),
  inboundDispatchMock: vi.fn(),
  resolveConversationLabelMock: vi.fn(),
  recordSessionMetaFromInboundMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  resolveStorePathMock: vi.fn(),
  deliverSlackSlashRepliesMock: vi.fn<(params: unknown) => Promise<unknown>>(async (params) => {
    const delivery = params as {
      replies?: unknown[];
      onReplySettled?: (settlement: { replyIndex: number; visibleReplySent: boolean }) => void;
    };
    delivery.replies?.forEach((_reply, replyIndex) =>
      delivery.onReplySettled?.({ replyIndex, visibleReplySent: true }),
    );
  }),
}));

vi.mock("./slash-dispatch.runtime.js", () => {
  return {
    deliverSlackSlashReplies: (params: unknown) => mocks.deliverSlackSlashRepliesMock(params),
    isChannelPartialDeliveryError: (error: unknown) =>
      Boolean(
        error &&
        typeof error === "object" &&
        (error as { code?: unknown }).code === "CHANNEL_PARTIAL_DELIVERY",
      ),
    resolveAgentRoute: (...args: unknown[]) => mocks.resolveAgentRouteMock(...args),
    resolveChunkMode: vi.fn(() => "auto"),
    resolveConversationLabel: (...args: unknown[]) => mocks.resolveConversationLabelMock(...args),
    resolveMarkdownTableMode: vi.fn(() => "auto"),
  };
});

type SlashHarnessMocks = {
  dispatchMock: ReturnType<typeof vi.fn>;
  turnPlanMock: ReturnType<typeof vi.fn>;
  readAllowFromStoreMock: ReturnType<typeof vi.fn>;
  upsertPairingRequestMock: ReturnType<typeof vi.fn>;
  resolveAgentRouteMock: ReturnType<typeof vi.fn>;
  buildContextMock: ReturnType<typeof vi.fn>;
  inboundDispatchMock: ReturnType<typeof vi.fn>;
  resolveConversationLabelMock: ReturnType<typeof vi.fn>;
  recordSessionMetaFromInboundMock: AsyncMock;
  resolveStorePathMock: ReturnType<typeof vi.fn>;
  deliverSlackSlashRepliesMock: AsyncMock;
};

export function getSlackSlashMocks(): SlashHarnessMocks {
  return mocks;
}

export function resetSlackSlashMocks() {
  mocks.dispatchMock.mockReset().mockResolvedValue({ counts: { final: 1, tool: 0, block: 0 } });
  mocks.turnPlanMock.mockReset();
  mocks.readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  mocks.upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  mocks.resolveAgentRouteMock.mockReset().mockReturnValue({
    agentId: "main",
    sessionKey: "session:1",
    accountId: "acct",
  });
  mocks.buildContextMock
    .mockReset()
    .mockImplementation((params: unknown) => buildChannelInboundEventContext(params as never));
  mocks.inboundDispatchMock.mockReset().mockImplementation(async (plan: unknown) => {
    const inboundPlan = plan as {
      cfg: unknown;
      ctxPayload: unknown;
      route: { sessionKey: string };
      dispatcherOptions?: { onSettled?: () => unknown };
      delivery: { deliver?: unknown; onError?: unknown };
      replyOptions?: unknown;
    };
    mocks.turnPlanMock(inboundPlan);
    void mocks.recordSessionMetaFromInboundMock({
      sessionKey:
        (inboundPlan.ctxPayload as { SessionKey?: string }).SessionKey ??
        inboundPlan.route.sessionKey,
      ctx: inboundPlan.ctxPayload,
    });
    let dispatchResult: unknown;
    try {
      const deliver = async (...args: unknown[]) => {
        const result = await (
          inboundPlan.delivery.deliver as (...deliveryArgs: unknown[]) => Promise<{
            finalization?: Promise<unknown>;
          } | void>
        )(...args);
        // Routed core observes deferred rejection immediately, then awaits the same
        // finalization during settlement. Mirror that ownership in this facade shim.
        void result?.finalization?.catch(() => undefined);
        return result;
      };
      dispatchResult = await mocks.dispatchMock({
        ctx: inboundPlan.ctxPayload,
        cfg: inboundPlan.cfg,
        dispatcherOptions: {
          ...inboundPlan.dispatcherOptions,
          deliver,
          onError: inboundPlan.delivery.onError,
        },
        replyOptions: inboundPlan.replyOptions,
      });
    } finally {
      await inboundPlan.dispatcherOptions?.onSettled?.();
    }
    return {
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: inboundPlan.ctxPayload,
      routeSessionKey: inboundPlan.route.sessionKey,
      dispatchResult,
    };
  });
  const runtime = createPluginRuntimeMock();
  setSlackRuntime({
    ...runtime,
    channel: {
      ...runtime.channel,
      inbound: {
        ...runtime.channel.inbound,
        buildContext: mocks.buildContextMock as PluginRuntime["channel"]["inbound"]["buildContext"],
        dispatch: mocks.inboundDispatchMock as PluginRuntime["channel"]["inbound"]["dispatch"],
      },
    },
  });
  mocks.resolveConversationLabelMock.mockReset().mockReturnValue(undefined);
  mocks.recordSessionMetaFromInboundMock.mockReset().mockResolvedValue(undefined);
  mocks.resolveStorePathMock.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");
  mocks.deliverSlackSlashRepliesMock.mockReset().mockImplementation(async (params: unknown) => {
    const delivery = params as {
      replies?: unknown[];
      onReplySettled?: (settlement: { replyIndex: number; visibleReplySent: boolean }) => void;
    };
    delivery.replies?.forEach((_reply, replyIndex) =>
      delivery.onReplySettled?.({ replyIndex, visibleReplySent: true }),
    );
  });
}
