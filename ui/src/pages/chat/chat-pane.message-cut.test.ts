import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import "./chat-pane.ts";
import { replaceChatAttachmentsFromEditor } from "./attachment-payload-store.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

type TestChatPane = HTMLElement & {
  connectedClient: GatewayBrowserClient | null;
  connectionGeneration: number;
  context: ApplicationContext;
  forkFromMessage: (entryId: string) => Promise<void>;
  onPaneSessionChange?: (paneId: string, sessionKey: string) => void;
  state: ChatPageHost;
  switchPaneSession: (sessionKey: string) => void;
};

function createSessionContext(
  client: GatewayBrowserClient,
  sessions: SessionCapability,
): ApplicationContext {
  return {
    gateway: {
      snapshot: {
        client,
        phase: "connected",
        hello: { features: { methods: [] } },
      },
    },
    agents: { state: { agentsList: null } },
    sessions,
  } as unknown as ApplicationContext;
}

function createTestChatPane(params: { client: GatewayBrowserClient; sessions: SessionCapability }) {
  const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
  Object.defineProperty(pane, "isConnected", {
    configurable: true,
    value: true,
  });
  const requestUpdate = vi.fn();
  const state = {
    agentsList: null,
    assistantAgentId: null,
    chatError: null,
    chatHistoryPagination: { hasMore: false },
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    client: params.client,
    connected: true,
    connectionEpoch: 4,
    hello: null,
    lastError: null,
    requestUpdate,
    sessionKey: "agent:main:current",
    sessions: params.sessions,
    sessionsError: null,
    sessionsLoading: false,
    sidebarContent: null,
    sidebarLayout: { columns: [] },
    // Minimal scroll host so scheduleChatScroll is a no-op instead of throwing.
    chatScrollGeneration: 0,
    chatScrollCommitCleanup: null,
    handleChatScroll: vi.fn(),
    handleChatDraftChange: vi.fn(),
    renderLifecycle: { afterCommit: () => () => {}, invalidate: () => {} },
  } as unknown as ChatPageHost;
  pane.context = createSessionContext(params.client, params.sessions);
  pane.state = state;
  pane.connectedClient = params.client;
  pane.connectionGeneration = 4;
  return { pane, state };
}

describe("chat pane message cuts", () => {
  it("restores forked prompt attachments into the new session composer", async () => {
    const sessions = {
      forkAtMessage: vi.fn().mockResolvedValue({
        sessionKey: "agent:main:forked",
        editorText: "edit me",
        editorAttachments: [
          { mimeType: "image/png", data: "aW1hZ2U=" },
          { mimeType: "video/mp4", data: "dmlkZW8=" },
        ],
      }),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    state.chatAttachments = [{ id: "old", mimeType: "image/jpeg", dataUrl: "data:old" }];
    pane.switchPaneSession = vi.fn((sessionKey: string) => {
      state.sessionKey = sessionKey;
      state.chatAttachments = [];
    });

    await pane.forkFromMessage("user-entry");

    expect(state.sessionKey).toBe("agent:main:forked");
    expect(state.chatAttachments).toEqual([
      {
        id: expect.stringMatching(/^att-/),
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      },
      {
        id: expect.stringMatching(/^att-/),
        mimeType: "video/mp4",
        dataUrl: "data:video/mp4;base64,dmlkZW8=",
      },
    ]);
  });

  it("keeps a newer global agent selection when a message fork finishes late", async () => {
    const forked = createDeferred<{ sessionKey: string; editorText?: string }>();
    const sessions = {
      forkAtMessage: vi.fn(() => forked.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    state.sessionKey = "global";
    state.assistantAgentId = "main";

    const pending = pane.forkFromMessage("user-entry");
    state.assistantAgentId = "work";
    forked.resolve({ sessionKey: "agent:main:forked", editorText: "edit me" });

    await pending;
    expect(navigate).not.toHaveBeenCalled();
    expect(state.sessionKey).toBe("global");
    expect(state.assistantAgentId).toBe("work");
  });

  it("preserves the source pane when fork attachment preflight is rejected", async () => {
    const sessions = {
      forkAtMessage: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Fork cannot restore this message because an attachment is missing or expired. The session was not changed.",
          ),
        ),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const attachments = [{ id: "keep", mimeType: "video/mp4", dataUrl: "data:keep" }];
    state.chatMessage = "keep draft";
    state.chatMessages = [{ role: "assistant", content: "keep history" }];
    state.chatAttachments = attachments;
    pane.onPaneSessionChange = vi.fn();
    pane.switchPaneSession = vi.fn();

    await pane.forkFromMessage("user-entry");

    expect(state.sessionKey).toBe("agent:main:current");
    expect(state.chatMessage).toBe("keep draft");
    expect(state.chatAttachments).toBe(attachments);
    expect(pane.onPaneSessionChange).not.toHaveBeenCalled();
    expect(pane.switchPaneSession).not.toHaveBeenCalled();
    expect(state.chatError).toContain("missing or expired");
  });

  it("validates restored media all-or-nothing before replacing the composer", () => {
    const current = [{ id: "keep", mimeType: "image/png", dataUrl: "data:keep" }];

    expect(() =>
      replaceChatAttachmentsFromEditor(current, [
        { mimeType: "image/png", data: "aW1hZ2U=" },
        { mimeType: "video/mp4", data: "not base64" },
      ]),
    ).toThrow("invalid restored attachment");
    expect(current).toEqual([{ id: "keep", mimeType: "image/png", dataUrl: "data:keep" }]);
  });

  it("accepts a 6 MiB restored video above the retired 5 MiB editor cap", () => {
    const sixMiBBase64 = "AAAA".repeat((6 * 1024 * 1024) / 3);

    const restored = replaceChatAttachmentsFromEditor(
      [],
      [{ mimeType: "video/mp4", data: sixMiBBase64 }],
    );

    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      id: expect.stringMatching(/^att-/),
      mimeType: "video/mp4",
    });
    expect(restored[0]?.dataUrl?.length).toBe(
      "data:video/mp4;base64,".length + sixMiBBase64.length,
    );
  });
});
