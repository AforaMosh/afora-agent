import { beforeEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { DispatchReplyWithDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createChannelPartialDeliveryError } from "./delivery-result.js";
import { dispatchRoutedChannelTurn } from "./lifecycle.js";

const dispatchReplyWithRoutedChannelDispatcherCore = vi.hoisted(() => vi.fn());
const getGlobalHookRunner = vi.hoisted(() => vi.fn());
const settlePendingFinalDelivery = vi.hoisted(() =>
  vi.fn(async (_completion: unknown, state: string) => ({ state })),
);

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessageWithRoutedChannelDispatcher: dispatchReplyWithRoutedChannelDispatcherCore,
  };
});

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/hook-runner-global.js")>();
  return { ...actual, getGlobalHookRunner };
});

vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession: vi.fn(async () => []),
}));

vi.mock("../../infra/outbound/delivery-completion.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/delivery-completion.js")>();
  return { ...actual, settlePendingFinalDelivery };
});

const cfg: OpenClawConfig = {};

function createCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    CommandAuthorized: false,
    From: "sender",
    To: "target",
    SessionKey: "agent:main:test:peer",
    Provider: "test",
    Surface: "test",
    ...overrides,
  };
}

describe("deferred finalization custody after a visible send", () => {
  const completion = {
    deliveryId: "delivery-final",
    intentId: "intent-final",
    sessionId: "session-final",
    sessionKey: "agent:main:telegram:peer",
    storePath: "/tmp/sessions.json",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getGlobalHookRunner.mockReturnValue(null);
    settlePendingFinalDelivery.mockImplementation(async (_completion, state: string) => ({
      state,
    }));
  });

  const run = (finalization: Promise<{ visibleReplySent: boolean; messageIds?: string[] }>) => {
    const sourcePayload = setReplyPayloadMetadata(
      { text: "reply" },
      { pendingFinalDeliveryCompletion: completion },
    );
    const dispatch: DispatchReplyWithDispatcher = async (params) => {
      await params.dispatcherOptions.deliver(sourcePayload, { kind: "final" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    };
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(dispatch);
    return dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      accountId: "acct",
      route: { agentId: "main", sessionKey: completion.sessionKey },
      ctxPayload: createCtx({ Surface: "telegram", OriginatingTo: "chat-1" }),
      delivery: {
        deliver: async (_payload: ReplyPayload) => ({
          visibleReplySent: true,
          finalization,
        }),
      },
    });
  };

  it("settles delivered when deferred finalization resolves", async () => {
    await run(Promise.resolve({ visibleReplySent: true, messageIds: ["56067"] }));

    expect(settlePendingFinalDelivery).toHaveBeenLastCalledWith(
      { kind: "pending-final", ...completion },
      "delivered",
    );
  });

  it("keeps unknown custody when finalization rejects with a true partial", async () => {
    // A partial proves something was visible, not that everything was; the
    // remainder may be lost. Unknown custody plus the recovery notice ("ask
    // for any missing remainder") is the designed outcome. Channels must not
    // reject content-complete deliveries this way — cosmetic post-content
    // failures stay channel-side (see telegram progress-window guards).
    const partial = createChannelPartialDeliveryError(new Error("chunk 2 send failed"), {
      visibleReplySent: true,
      messageIds: ["56067"],
    });

    await expect(run(Promise.reject(partial))).rejects.toBeDefined();

    expect(settlePendingFinalDelivery).toHaveBeenLastCalledWith(
      { kind: "pending-final", ...completion },
      "unknown",
      ["queued", "unknown"],
    );
  });
});
