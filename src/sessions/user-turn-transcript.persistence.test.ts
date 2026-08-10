// User turn persistence tests cover the shared transcript writer.
import fs from "node:fs";
import path from "node:path";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { castAgentMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../agents/harness/hook-helpers.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { persistUserTurnTranscript } from "./user-turn-transcript.test-support.js";

describe("persistUserTurnTranscript", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    resetGlobalHookRunner();
  });

  function createSqliteTranscriptTarget(params: {
    dir: string;
    sessionId?: string;
    sessionKey?: string;
  }) {
    const sessionId = params.sessionId ?? "session-1";
    const sessionKey = params.sessionKey ?? "agent:main:main";
    const storePath = path.join(params.dir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const sqliteMarker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    return {
      agentId: "main",
      cwd: params.dir,
      sessionEntry: undefined,
      sessionId,
      sessionKey,
      storePath,
      sqliteMarker,
    };
  }

  async function readTranscriptMessages(params: {
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }): Promise<Array<Record<string, unknown>>> {
    return (
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      })
    )
      .map((entry) => (entry as { message?: unknown }).message)
      .filter(
        (message): message is Record<string, unknown> =>
          typeof message === "object" && message !== null,
      );
  }

  it("appends a structured user turn through the shared transcript writer", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-");
    const target = createSqliteTranscriptTarget({ dir });
    const provenance = {
      kind: "inter_session" as const,
      sourceSessionKey: "source-main",
      sourceTool: "sessions_send",
    };

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "What is in this image?",
        media: [{ path: "/tmp/image.png", contentType: "image/png" }],
        timestamp: 123,
        senderIsOwner: true,
        provenance,
      },
      updateMode: "none",
    });

    const expected = {
      role: "user",
      content: "What is in this image?",
      timestamp: 123,
      __openclaw: {
        senderIsOwner: false,
        media: [{ path: "/tmp/image.png", contentType: "image/png" }],
      },
      provenance,
    };
    const expectedStored = {
      ...expected,
      __openclaw: {
        ...expected["__openclaw"],
        media: [{ path: "/tmp/image.png", sourceIndex: 0, contentType: "image/png" }],
      },
    };
    expect(appended?.message).toEqual(expected);
    expect(JSON.stringify(appended?.message)).toBe(JSON.stringify(expected));
    const messages = await readTranscriptMessages(target);
    expect(messages).toEqual([expectedStored]);
    expect(JSON.stringify(messages[0])).toBe(JSON.stringify(expectedStored));
  });

  it("round-trips a multi-attachment SQLite row byte-identically", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-media-");
    const target = createSqliteTranscriptTarget({ dir });
    const expected = {
      role: "user",
      content: "Inspect both",
      timestamp: 456,
      __openclaw: {
        media: [
          { path: "/tmp/image.png", contentType: "image/png" },
          {
            url: "https://example.test/report.pdf",
            contentType: "application/pdf",
          },
        ],
      },
    };
    const expectedStored = {
      ...expected,
      __openclaw: {
        media: [
          { path: "/tmp/image.png", sourceIndex: 0, contentType: "image/png" },
          {
            sourceIndex: 1,
            url: "https://example.test/report.pdf",
            contentType: "application/pdf",
          },
        ],
      },
    };

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "Inspect both",
        timestamp: 456,
        media: [
          { path: "/tmp/image.png", contentType: "image/png" },
          { url: "https://example.test/report.pdf", contentType: "application/pdf" },
        ],
      },
      updateMode: "none",
    });

    expect(appended?.message).toEqual(expected);
    expect(JSON.stringify(appended?.message)).toBe(JSON.stringify(expected));
    const messages = await readTranscriptMessages(target);
    expect(messages).toEqual([expectedStored]);
    expect(JSON.stringify(messages[0])).toBe(JSON.stringify(expectedStored));
  });

  it("persists sender metadata as __openclaw envelope", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-sender-");
    const target = createSqliteTranscriptTarget({ dir });
    // Deliberately attach runtime-only profile fields to prove durable sender
    // attribution is a whitelist, not a copy of the inbound sender object.
    const runtimeOnlySenderFields = {
      senderProfileAvatarUrl: "/api/users/8489979671/avatar?v=1989876543210",
      profileRevision: 1_989_876_543_210,
      avatarBytes: "volatile-avatar-bytes",
      avatarHash: "volatile-avatar-hash",
    };
    const sender = {
      id: "8489979671",
      name: "Ram Shenoy",
      username: "ram_s",
      ...runtimeOnlySenderFields,
    };
    const expected = {
      role: "user",
      content: "hello from group",
      timestamp: 1_700_000_000_000,
      __openclaw: {
        senderId: "8489979671",
        senderName: "Ram Shenoy",
        senderUsername: "ram_s",
      },
    };

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello from group",
        timestamp: expected.timestamp,
        sender,
      },
      updateMode: "none",
    });

    const reloaded = await readTranscriptMessages(target);
    const durableMessages = [appended?.message, reloaded[0]];
    expect(durableMessages).toEqual([expected, expected]);
    for (const durableMessage of durableMessages) {
      const serialized = JSON.stringify(durableMessage);
      for (const [key, value] of Object.entries(runtimeOnlySenderFields)) {
        expect(serialized).not.toContain(key);
        expect(serialized).not.toContain(String(value));
      }
    }
  });

  it("omits __openclaw when no sender metadata is provided", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-nosender-");
    const target = createSqliteTranscriptTarget({ dir });

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello without sender",
        sender: { id: "", name: null },
      },
      updateMode: "none",
    });

    expect(appended?.message).not.toHaveProperty("__openclaw");
  });

  it("uses inline update mode by default", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-inline-");
    const target = createSqliteTranscriptTarget({ dir });

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello from runtime",
      },
    });

    expect(appended?.message).toMatchObject({
      role: "user",
      content: "hello from runtime",
      timestamp: expect.any(Number),
    });
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "hello from runtime",
        timestamp: expect.any(Number),
      }),
    ]);
  });

  it("returns the existing user turn when the idempotency key was already persisted", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-idempotent-");
    const target = createSqliteTranscriptTarget({ dir });

    const first = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello once",
        timestamp: 123,
        idempotencyKey: "chat-run-1:user",
      },
      updateMode: "none",
    });
    const second = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello once replayed",
        timestamp: 456,
        idempotencyKey: "chat-run-1:user",
      },
      updateMode: "none",
    });

    expect(second?.messageId).toBe(first?.messageId);
    expect(second?.message).toMatchObject({
      role: "user",
      content: "hello once",
      timestamp: 123,
      idempotencyKey: "chat-run-1:user",
    });
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "hello once",
        timestamp: 123,
        idempotencyKey: "chat-run-1:user",
      }),
    ]);
  });

  it("preserves transcript metadata when before_message_write replaces a user turn", async () => {
    let hookCalls = 0;
    const provenance = {
      kind: "inter_session" as const,
      sourceSessionKey: "source-main",
      sourceTool: "sessions_send",
    };
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => {
            hookCalls += 1;
            const message = (event as { message: Record<string, unknown> }).message;
            const meta = message["__openclaw"] as {
              transport?: { conversationRef?: string; messageId?: string };
            };
            if (meta.transport) {
              meta.transport.conversationRef = "conv_tampered";
              meta.transport.messageId = "tampered-message";
            }
            return {
              message: castAgentMessage({
                role: "user",
                content: "[redacted by hook]",
                __openclaw: { hookOwned: true },
              }),
            };
          },
        },
      ]),
    );
    const dir = tempDirs.make("openclaw-user-turn-redacted-idempotent-");
    const target = createSqliteTranscriptTarget({ dir });

    await persistUserTurnTranscript({
      ...target,
      input: {
        text: "secret prompt",
        idempotencyKey: "chat-run-1:user",
        senderIsOwner: true,
        provenance,
        sender: { id: "user-42", name: "Ada" },
        transport: {
          channel: "reef",
          conversationRef: "conv_0123456789abcdef0123456789abcdef",
          messageId: "inbound-1",
          replyToId: "outbound-1",
        },
      },
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });
    await persistUserTurnTranscript({
      ...target,
      input: {
        text: "secret prompt",
        idempotencyKey: "chat-run-1:user",
        senderIsOwner: true,
        provenance,
        sender: { id: "user-42", name: "Ada" },
        transport: {
          channel: "reef",
          conversationRef: "conv_0123456789abcdef0123456789abcdef",
          messageId: "inbound-1",
          replyToId: "outbound-1",
        },
      },
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });

    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "[redacted by hook]",
        idempotencyKey: "chat-run-1:user",
        provenance,
        __openclaw: {
          hookOwned: true,
          senderIsOwner: false,
          transport: {
            channel: "reef",
            conversationRef: "conv_0123456789abcdef0123456789abcdef",
            messageId: "inbound-1",
            replyToId: "outbound-1",
          },
        },
      }),
    ]);
    expect(hookCalls).toBe(1);
  });

  it.each(["erase", "mutate", "forge"] as const)(
    "keeps video-description provenance authoritative when a write hook tries to %s it",
    async (mode) => {
      const dir = tempDirs.make(`openclaw-user-turn-video-${mode}-`);
      const target = createSqliteTranscriptTarget({ dir });
      const originalDescriptions =
        mode === "forge" ? undefined : [{ sourceId: "original-video", sourceIndex: 1 }];
      const persisted = await persistUserTurnTranscript({
        ...target,
        input: {
          text: "described clip",
          media: [
            {
              path: path.join(dir, "frame.png"),
              contentType: "image/png",
              sourceIndex: 0,
            },
            {
              path: path.join(dir, "clip.mp4"),
              contentType: "video/mp4",
              sourceId: "original-video",
              sourceIndex: 1,
            },
          ],
          mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
          ...(originalDescriptions ? { mediaVideoDescriptions: originalDescriptions } : {}),
        },
        beforeMessageWrite: ({ message }) => {
          const metadata = (message as unknown as { __openclaw?: Record<string, unknown> })[
            "__openclaw"
          ];
          if (!metadata) {
            throw new Error("expected prepared OpenClaw metadata");
          }
          metadata.hookOwned = true;
          if (mode === "erase") {
            delete metadata.mediaVideoDescriptions;
          } else if (mode === "mutate") {
            const descriptions = metadata.mediaVideoDescriptions as Array<{
              sourceId?: string;
              sourceIndex: number;
            }>;
            descriptions[0] = { sourceId: "forged-video", sourceIndex: 99 };
          } else {
            metadata.mediaVideoDescriptions = [{ sourceId: "forged-video", sourceIndex: 99 }];
          }
          return message;
        },
        updateMode: "none",
      });

      const stored = await readTranscriptMessages(target);
      for (const message of [persisted?.message, stored[0]]) {
        const metadata = (message as { __openclaw?: Record<string, unknown> } | undefined)?.[
          "__openclaw"
        ];
        expect(metadata?.hookOwned).toBe(true);
        expect(metadata?.media).toEqual([
          expect.objectContaining({
            sourceIndex: 0,
            contentType: "image/png",
          }),
          expect.objectContaining({
            sourceId: "original-video",
            sourceIndex: 1,
            contentType: "video/mp4",
          }),
        ]);
        expect(metadata?.mediaImageLayout).toEqual({
          slots: [{ kind: "offloaded", factIndex: 0 }],
        });
        if (originalDescriptions) {
          expect(metadata?.mediaVideoDescriptions).toEqual(originalDescriptions);
        } else {
          expect(metadata?.mediaVideoDescriptions).toBeUndefined();
        }
      }
    },
  );
});
