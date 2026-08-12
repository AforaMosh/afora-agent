// WhatsApp web auto-reply routing behavior.
import "./test-helpers.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installWebAutoReplyUnitTestHooks, makeSessionStore } from "./auto-reply.test-harness.js";
import { buildMentionConfig } from "./auto-reply/mentions.js";
import { createEchoTracker } from "./auto-reply/monitor/echo.js";
import { createWebOnMessageHandler } from "./auto-reply/monitor/on-message.js";
import { createTestWebInboundMessage } from "./inbound/test-message.test-helper.js";

const updateLastRouteInBackgroundMock = vi.hoisted(() => vi.fn());
const runChannelInboundEventMock = vi.hoisted(() =>
  vi.fn(async () => ({ dispatched: false }) as never),
);

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    runChannelInboundEvent: runChannelInboundEventMock,
  };
});

vi.mock("./auto-reply/monitor/last-route.js", async () => {
  const actual = await vi.importActual<typeof import("./auto-reply/monitor/last-route.js")>(
    "./auto-reply/monitor/last-route.js",
  );
  return {
    ...actual,
    updateLastRouteInBackground: (...args: unknown[]) => updateLastRouteInBackgroundMock(...args),
  };
});

function makeCfg(storePath: string): OpenClawConfig {
  return {
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: storePath },
  };
}

function makeReplyLogger() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as Parameters<typeof createWebOnMessageHandler>[0]["replyLogger"];
}

function createHandlerForTest(opts: { cfg: OpenClawConfig; replyResolver: unknown }) {
  const backgroundTasks = new Set<Promise<unknown>>();
  const replyLogger = makeReplyLogger();
  const handler = createWebOnMessageHandler({
    cfg: opts.cfg,
    verbose: false,
    connectionId: "test",
    maxMediaBytes: 1024,
    groupHistoryLimit: 3,
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    echoTracker: createEchoTracker({ maxItems: 10 }),
    backgroundTasks,
    replyResolver: opts.replyResolver as Parameters<
      typeof createWebOnMessageHandler
    >[0]["replyResolver"],
    replyLogger,
    baseMentionConfig: buildMentionConfig(opts.cfg),
    account: {},
  });

  return { handler, backgroundTasks };
}

function buildInboundMessage(params: {
  id: string;
  from: string;
  conversationId: string;
  chatType: "direct" | "group";
  chatId: string;
  timestamp: number;
  body?: string;
  to?: string;
  accountId?: string;
  senderId?: string;
  senderE164?: string;
  senderLid?: string;
  senderName?: string;
  selfE164?: string;
}) {
  return createTestWebInboundMessage({
    event: {
      id: params.id,
      timestamp: params.timestamp,
    },
    payload: {
      body: params.body ?? "hello",
    },
    platform: {
      chatJid: params.chatId,
      recipientJid: params.to ?? "+2000",
      sender:
        params.senderE164 || params.senderLid
          ? { e164: params.senderE164, lid: params.senderLid, name: params.senderName }
          : undefined,
      senderE164: params.senderE164,
      senderJid: params.senderLid,
      senderName: params.senderName,
      selfE164: params.selfE164,
    },
    admission: {
      accountId: params.accountId ?? "default",
      conversation: {
        kind: params.chatType,
        id: params.conversationId,
      },
      sender: {
        id: params.senderId ?? params.senderE164 ?? params.from,
      },
    },
  });
}

describe("web auto-reply routing", () => {
  installWebAutoReplyUnitTestHooks();

  beforeEach(() => {
    updateLastRouteInBackgroundMock.mockClear();
    runChannelInboundEventMock.mockClear();
  });

  it("updates last-route for direct chats without senderE164", async () => {
    const now = Date.now();
    const mainSessionKey = "agent:main:main";
    const store = await makeSessionStore({
      [mainSessionKey]: { sessionId: "sid", updatedAt: now - 1 },
    });

    const cfg = makeCfg(store.storePath);
    const { handler, backgroundTasks } = createHandlerForTest({
      cfg,
      replyResolver: vi.fn().mockResolvedValue(undefined),
    });

    await handler(
      buildInboundMessage({
        id: "m1",
        from: "+1000",
        conversationId: "+1000",
        chatType: "direct",
        chatId: "direct:+1000",
        timestamp: now,
      }),
    );

    await Promise.allSettled(backgroundTasks);
    backgroundTasks.clear();

    expect(updateLastRouteInBackgroundMock).toHaveBeenCalledTimes(1);
    const updateParams = updateLastRouteInBackgroundMock.mock.calls.at(0)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(updateParams?.cfg).toBe(cfg);
    expect(updateParams?.backgroundTasks).toBe(backgroundTasks);
    expect(updateParams?.warn).toBeTypeOf("function");
    const {
      cfg: _cfg,
      backgroundTasks: _backgroundTasks,
      warn: _warn,
      ctx,
      ...routeParams
    } = updateParams ?? {};
    expect(routeParams).toEqual({
      storeAgentId: "main",
      sessionKey: mainSessionKey,
      channel: "whatsapp",
      to: "+1000",
      accountId: "default",
    });
    expect(ctx).toMatchObject({
      From: "+1000",
      To: "+2000",
      SessionKey: mainSessionKey,
      AccountId: "default",
      ChatType: "direct",
      ConversationLabel: "+1000",
      GroupMembers: "+1000",
      MessageSid: "m1",
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "+1000",
      SenderE164: "+1000",
      SenderId: "+1000",
      RawBody: "hello",
      Body: expect.stringMatching(/^\[WhatsApp \+1000 .+\] \+1000: hello$/u),
      BodyForAgent: "hello",
      CommandBody: "hello",
      Timestamp: now,
    });

    await store.cleanup();
  });

  it.each([
    {
      name: "an exact LID pin",
      allowFrom: "999@lid",
      from: "999@lid",
      senderId: "999@lid",
      senderLid: "999@lid",
      expectedTo: "999@lid",
    },
    {
      name: "an E.164 pin proven as the authoritative LID owner's alias",
      allowFrom: "+1555",
      from: "999@lid",
      senderId: "999@lid",
      senderLid: "999@lid",
      senderE164: "+1555",
      expectedTo: "999@lid",
    },
    {
      name: "a mapped-first E.164 owner",
      allowFrom: "+1555",
      from: "+1555",
      senderId: "+1555",
      senderE164: "+1555",
      expectedTo: "+1555",
    },
    {
      name: "a provider-prefixed exact LID pin",
      allowFrom: "whatsapp:999@lid",
      from: "999@lid",
      senderId: "999@lid",
      senderLid: "999@lid",
      expectedTo: "999@lid",
    },
    {
      name: "an unrelated E.164 alias",
      allowFrom: "+1555",
      from: "999@lid",
      senderId: "999@lid",
      senderLid: "999@lid",
      senderE164: "+1666",
      expectedTo: null,
    },
    {
      name: "a same-digit phone under a provider-prefixed LID pin",
      allowFrom: "whatsapp:999@lid",
      from: "+999",
      senderId: "+999",
      senderE164: "+999",
      expectedTo: null,
    },
  ])("handles $name without leaking the pinned main route", async (testCase) => {
    const now = Date.now();
    const mainSessionKey = "agent:main:main";
    const store = await makeSessionStore({
      [mainSessionKey]: {
        sessionId: "sid",
        updatedAt: now - 1,
        lastChannel: "whatsapp",
        lastTo: "+1444",
      },
    });
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: [testCase.allowFrom],
        },
      },
      session: { store: store.storePath },
    };
    const { handler, backgroundTasks } = createHandlerForTest({
      cfg,
      replyResolver: vi.fn().mockResolvedValue(undefined),
    });

    await handler(
      buildInboundMessage({
        id: "lid-1",
        from: testCase.from,
        conversationId: testCase.senderId,
        chatType: "direct",
        chatId: testCase.from,
        timestamp: now,
        senderId: testCase.senderId,
        senderE164: testCase.senderE164,
        senderLid: testCase.senderLid,
      }),
    );

    await Promise.allSettled(backgroundTasks);
    backgroundTasks.clear();

    expect(updateLastRouteInBackgroundMock).toHaveBeenCalledTimes(testCase.expectedTo ? 1 : 0);
    if (testCase.expectedTo) {
      expect(updateLastRouteInBackgroundMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: mainSessionKey,
          channel: "whatsapp",
          to: testCase.expectedTo,
          accountId: "default",
        }),
      );
    }

    await store.cleanup();
  });

  it("updates last-route for group chats with account id", async () => {
    const now = Date.now();
    const groupSessionKey = "agent:main:whatsapp:group:123@g.us";
    const store = await makeSessionStore({
      [groupSessionKey]: { sessionId: "sid", updatedAt: now - 1 },
    });

    const cfg = makeCfg(store.storePath);
    const { handler, backgroundTasks } = createHandlerForTest({
      cfg,
      replyResolver: vi.fn().mockResolvedValue(undefined),
    });

    await handler(
      buildInboundMessage({
        id: "g1",
        from: "123@g.us",
        conversationId: "123@g.us",
        chatType: "group",
        chatId: "123@g.us",
        body: "hello +2000",
        timestamp: now,
        accountId: "work",
        senderE164: "+1000",
        senderName: "Alice",
        selfE164: "+2000",
      }),
    );

    await Promise.allSettled(backgroundTasks);
    backgroundTasks.clear();

    expect(updateLastRouteInBackgroundMock).toHaveBeenCalledTimes(1);
    const updateParams = updateLastRouteInBackgroundMock.mock.calls.at(0)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(updateParams?.cfg).toBe(cfg);
    expect(updateParams?.backgroundTasks).toBe(backgroundTasks);
    expect(updateParams?.warn).toBeTypeOf("function");
    const {
      cfg: _cfg,
      backgroundTasks: _backgroundTasks,
      warn: _warn,
      ctx,
      ...routeParams
    } = updateParams ?? {};
    expect(routeParams).toEqual({
      storeAgentId: "main",
      sessionKey: `${groupSessionKey}:thread:whatsapp-account-work`,
      channel: "whatsapp",
      to: "123@g.us",
      accountId: "work",
    });
    expect(ctx).toEqual({
      From: "123@g.us",
      To: "+2000",
      SessionKey: `${groupSessionKey}:thread:whatsapp-account-work`,
      AccountId: "work",
      ChatType: "group",
      ConversationLabel: "123@g.us",
      GroupSubject: undefined,
      SenderName: "Alice",
      SenderId: "+1000",
      SenderE164: "+1000",
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "123@g.us",
    });

    await store.cleanup();
  });
});
