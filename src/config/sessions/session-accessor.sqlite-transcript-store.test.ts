import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  persistSessionTranscriptTurn,
  readSessionTranscriptMessageEvents,
} from "./session-accessor.js";
import {
  replaceSqliteTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const videoPayload = Buffer.concat([
  Buffer.from("000000186674797069736f6d00000200", "hex"),
  Buffer.from("secret-video".repeat(8_192)),
]).toString("base64");
const videoBlock = { type: "video" as const, data: videoPayload, mimeType: "video/mp4" };
const videoFact = {
  sourceId: "recording.mp4",
  sourceIndex: 0,
  path: "/private/inbound/recording.mp4",
  url: "media://inbound/recording.mp4",
  contentType: "video/mp4",
  kind: "video" as const,
};
const videoOmission = {
  type: "text",
  text: "(video omitted: inline video is not retained in session history)",
};

describe("SQLite transcript native video claim checks", () => {
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(() => {
    scope = {
      agentId: "main",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: tempDirs.make("openclaw-transcript-video-"),
      },
      sessionId: "native-video-transcript",
      sessionKey: "agent:main:native-video-transcript",
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  const persistMessage = async (message: Record<string, unknown>, eventId = "video-turn") => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId, parentId: null, message }],
      touchSessionEntry: false,
    });
  };

  const readStoredRow = () => {
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const row = database.db
      .prepare(
        "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(scope.sessionId) as { event_json: string; seq: number } | undefined;
    if (!row) {
      throw new Error("expected a persisted transcript event");
    }
    return {
      ...row,
      event: JSON.parse(row.event_json) as {
        id: string;
        message: {
          content: unknown;
          role: string;
          __openclaw?: { media?: unknown[]; mediaBlockFactIndexes?: unknown[] };
        };
      },
    };
  };

  it("stores only the durable video reference without changing live input", async () => {
    const content = [{ type: "text", text: "describe this recording" }, videoBlock];
    const message = {
      role: "user",
      content,
      __openclaw: { media: [videoFact], mediaBlockFactIndexes: [0] },
    };

    await persistMessage(message);

    const stored = readStoredRow();
    expect(stored.event.message).toEqual({
      role: "user",
      content: "describe this recording",
      __openclaw: { media: [videoFact] },
    });
    expect(stored.event_json).not.toContain(videoPayload);
    expect(Buffer.byteLength(stored.event_json)).toBeLessThan(1_024);
    expect(message.content).toBe(content);
    expect(message.content[1]).toBe(videoBlock);
  });

  it("strips every inline video by type while preserving non-video order", async () => {
    const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const unstagedVideo = { type: "video", data: "bG9jYWw=", mimeType: "video/webm" };
    const message = {
      role: "user",
      content: [
        { type: "text", text: "before" },
        image,
        videoBlock,
        { type: "text", text: "after" },
        unstagedVideo,
      ],
      __openclaw: {
        media: [{ path: "/private/inbound/still.png", contentType: "image/png" }, videoFact],
        mediaBlockFactIndexes: [0, 1, null],
      },
    };

    await persistMessage(message);

    expect(readStoredRow().event.message.content).toEqual([
      { type: "text", text: "before" },
      image,
      { type: "text", text: "after" },
      videoOmission,
    ]);
    expect(readStoredRow().event.message.__openclaw?.mediaBlockFactIndexes).toEqual([0]);
    expect(readStoredRow().event_json).not.toContain('"type":"video"');
    expect(message.content).toHaveLength(5);
  });

  it("uses block provenance for one omission beside reordered same-MIME managed video", async () => {
    const pluginVideo = { type: "video" as const, data: "cGx1Z2luLXZpZGVv", mimeType: "video/mp4" };
    const message = {
      role: "user",
      content: [pluginVideo, { type: "text", text: "between" }, videoBlock],
      __openclaw: { media: [videoFact], mediaBlockFactIndexes: [null, 0] },
    };

    await persistMessage(message);

    const stored = readStoredRow();
    expect(stored.event.message.content).toEqual([
      videoOmission,
      { type: "text", text: "between" },
    ]);
    expect(stored.event.message.__openclaw?.mediaBlockFactIndexes).toBeUndefined();
    expect(stored.event_json).not.toContain(pluginVideo.data);
    expect(stored.event_json).not.toContain(videoPayload);
    expect(stored.event_json).not.toContain('"type":"video"');
  });

  it("treats every video as factless when block provenance is missing", async () => {
    const pluginVideo = { type: "video" as const, data: "cGx1Z2luLXZpZGVv", mimeType: "video/mp4" };

    await persistMessage({
      role: "user",
      content: [videoBlock, pluginVideo],
      __openclaw: { media: [videoFact] },
    });

    const stored = readStoredRow();
    expect(stored.event.message.content).toEqual([videoOmission, videoOmission]);
    expect(stored.event_json).not.toContain(videoPayload);
    expect(stored.event_json).not.toContain(pluginVideo.data);
    expect(stored.event_json).not.toContain('"type":"video"');
  });

  it("keeps captionless video turns empty while retaining their claim check", async () => {
    await persistMessage({
      role: "user",
      content: [videoBlock],
      __openclaw: { media: [videoFact], mediaBlockFactIndexes: [0] },
    });

    expect(readStoredRow().event.message).toEqual({
      role: "user",
      content: "",
      __openclaw: { media: [videoFact] },
    });
  });

  it.each([
    {
      name: "mismatched source ID",
      fact: { ...videoFact, sourceId: "different-recording.mp4" },
    },
    {
      name: "malformed inbound URI",
      fact: { ...videoFact, url: "media://inbound/nested%2Frecording.mp4" },
    },
    {
      name: "missing source index",
      fact: { ...videoFact, sourceIndex: undefined },
    },
  ])("retains a bounded omission for a $name claim", async ({ fact }) => {
    await persistMessage({
      role: "user",
      content: [videoBlock],
      __openclaw: { media: [fact], mediaBlockFactIndexes: [0] },
    });

    const stored = readStoredRow();
    expect(stored.event.message.content).toBe(videoOmission.text);
    expect(stored.event_json).not.toContain(videoPayload);
    expect(stored.event_json).not.toContain('"type":"video"');
  });

  it("deduplicates native video retries against the persisted claim-check shape", async () => {
    const content = [{ type: "text", text: "retry this recording" }, videoBlock];
    const message = {
      role: "user",
      content,
      idempotencyKey: "native-video-retry",
      __openclaw: { media: [videoFact], mediaBlockFactIndexes: [0] },
    };
    const first = await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "first-video-turn", message }],
      touchSessionEntry: false,
    });

    const retry = await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "retried-video-turn", message }],
      touchSessionEntry: false,
    });

    expect(first.messages[0]).toMatchObject({ appended: true, messageId: "first-video-turn" });
    expect(retry.messages[0]).toMatchObject({
      appended: false,
      message: { content: "retry this recording", idempotencyKey: "native-video-retry" },
      messageId: "first-video-turn",
    });
    expect(message.content).toBe(content);
    expect(message.content[1]).toBe(videoBlock);
  });

  it.each([
    {
      name: "direct SDK video without a durable fact",
      message: { role: "user", content: [videoBlock] },
      expectedContent: videoOmission.text,
    },
    {
      name: "a fact with a different video MIME type",
      message: {
        role: "user",
        content: [videoBlock],
        __openclaw: {
          media: [{ ...videoFact, contentType: "video/webm" }],
          mediaBlockFactIndexes: [0],
        },
      },
      expectedContent: "",
    },
    {
      name: "an externally hosted URL without a managed local reference",
      message: {
        role: "user",
        content: [videoBlock],
        __openclaw: {
          media: [{ url: "https://example.com/recording.mp4", contentType: "video/mp4" }],
          mediaBlockFactIndexes: [0],
        },
      },
      expectedContent: videoOmission.text,
    },
    {
      name: "an arbitrary local path without a managed claim",
      message: {
        role: "user",
        content: [videoBlock],
        __openclaw: {
          media: [{ path: "/tmp/unmanaged.mp4", contentType: "video/mp4", kind: "video" }],
          mediaBlockFactIndexes: [0],
        },
      },
      expectedContent: videoOmission.text,
    },
    {
      name: "assistant-owned video content",
      message: {
        role: "assistant",
        content: [videoBlock],
        __openclaw: { media: [videoFact], mediaBlockFactIndexes: [0] },
      },
      expectedContent: [videoOmission],
    },
    {
      name: "tool-result video content",
      message: {
        role: "toolResult",
        toolCallId: "call-video",
        toolName: "camera",
        content: [videoBlock],
        isError: false,
      },
      expectedContent: [videoOmission],
    },
  ])("persists no inline bytes for $name", async ({ message, expectedContent }) => {
    await persistMessage(message);

    const stored = readStoredRow();
    expect(stored.event.message.content).toEqual(expectedContent);
    expect(stored.event_json).not.toContain(videoPayload);
    expect(stored.event_json).not.toContain('"type":"video"');
  });

  it("projects video claim checks when an entire transcript is replaced", async () => {
    await persistMessage({ role: "user", content: "before replacement" }, "before");
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const header = database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq LIMIT 1")
      .get(scope.sessionId) as { event_json: string };
    const replacement = {
      type: "message",
      id: "replacement",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: "replacement" }, videoBlock],
        __openclaw: { media: [videoFact], mediaBlockFactIndexes: [0] },
      },
    };

    runOpenClawAgentWriteTransaction(
      (writeDatabase) =>
        replaceSqliteTranscriptEventsInTransaction(writeDatabase, scope, [
          JSON.parse(header.event_json),
          replacement,
        ]),
      { agentId: scope.agentId, env: scope.env },
    );

    expect(readStoredRow().event.message.content).toBe("replacement");
    expect(replacement.message.content[1]).toBe(videoBlock);
  });

  it("projects factless custom-message video to bounded text", async () => {
    await persistMessage({ role: "user", content: "before custom message" }, "before-custom");
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const header = database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq LIMIT 1")
      .get(scope.sessionId) as { event_json: string };
    const custom = {
      type: "custom_message",
      id: "custom-video",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "recording",
      content: [{ type: "text", text: "custom clip" }, videoBlock],
      display: true,
    };

    runOpenClawAgentWriteTransaction(
      (writeDatabase) =>
        replaceSqliteTranscriptEventsInTransaction(writeDatabase, scope, [
          JSON.parse(header.event_json),
          custom,
        ]),
      { agentId: scope.agentId, env: scope.env },
    );

    const stored = database.db
      .prepare(
        "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(scope.sessionId) as { event_json: string };
    expect(JSON.parse(stored.event_json)).toMatchObject({
      type: "custom_message",
      content: [{ type: "text", text: "custom clip" }, videoOmission],
    });
    expect(stored.event_json).not.toContain(videoPayload);
    expect(stored.event_json).not.toContain('"type":"video"');
  });

  it("sanitizes durable media URLs and nested tool detail video", async () => {
    const privateData = "cHJpdmF0ZS12aWRlbw==";
    const wrappedFragments = ["cHJpdmF0ZS", "12aWRlby1w", "YXlsb2Fk"];
    await persistMessage({
      role: "toolResult",
      toolCallId: "call-private",
      toolName: "camera",
      content: [{ type: "text", text: "captured" }],
      details: {
        nested: { type: "video", mimeType: "video/mp4", data: privateData },
        uri: `captured clip: data:video/mp4;base64,${wrappedFragments.join(" \t\n")}`,
      },
      isError: false,
    });

    const storedDetails = readStoredRow().event_json;
    expect(storedDetails).not.toContain(privateData);
    expect(storedDetails).not.toContain('"type":"video"');
    expect(storedDetails).not.toContain("data:video/");
    for (const fragment of wrappedFragments) {
      expect(storedDetails).not.toContain(fragment);
    }

    await persistMessage(
      {
        role: "user",
        content: "remote clip",
        __openclaw: {
          media: [
            {
              sourceId: "remote",
              sourceIndex: 0,
              kind: "video",
              url: "https://user" + ":password@cdn.example.test/clip.mp4?signature=private#preview",
            },
          ],
        },
      },
      "signed-url",
    );
    const storedUrl = readStoredRow().event_json;
    expect(storedUrl).toContain("https://cdn.example.test/clip.mp4");
    expect(storedUrl).not.toContain("password");
    expect(storedUrl).not.toContain("signature");
  });

  it("rejects inline data references before SQLite history persistence", async () => {
    const inlinePayload = "cHJpdmF0ZS1pbmxpbmUtbWVkaWE=";
    await persistMessage(
      {
        role: "user",
        content: "inspect these references",
        __openclaw: {
          media: [
            {
              sourceId: "inline-video",
              sourceIndex: 0,
              url: `data:video/mp4;base64,${inlinePayload}`,
              contentType: "video/mp4",
              kind: "video",
            },
            {
              sourceId: "inline-image",
              sourceIndex: 1,
              path: `data:image/png;base64,${inlinePayload}`,
              contentType: "image/png",
              kind: "image",
            },
            {
              sourceId: "managed-video",
              sourceIndex: 2,
              url: "media://inbound/managed.mp4",
              contentType: "video/mp4",
              kind: "video",
            },
            {
              sourceId: "remote-video",
              sourceIndex: 3,
              url: "https://user" + ":password@cdn.example.test/clip.mp4?signature=private",
              contentType: "video/mp4",
              kind: "video",
            },
            {
              sourceId: "local-video",
              sourceIndex: 4,
              path: "/tmp/local.mp4",
              contentType: "video/mp4",
              kind: "video",
            },
            {
              sourceId: "malformed-remote-video",
              sourceIndex: 5,
              url:
                "https://user" +
                ":private-password@cdn.example.test:not-a-port/clip.mp4?signature=private-query",
              contentType: "video/mp4",
              kind: "video",
            },
          ],
        },
      },
      "inline-media-reference",
    );

    const stored = readStoredRow();
    const history = readSessionTranscriptMessageEvents(scope);
    for (const serialized of [stored.event_json, JSON.stringify(history)]) {
      expect(serialized).not.toContain("data:");
      expect(serialized).not.toContain(inlinePayload);
      expect(serialized).not.toContain("password");
      expect(serialized).not.toContain("signature");
      expect(serialized).not.toContain("private-password");
      expect(serialized).not.toContain("private-query");
    }
    expect(stored.event.message.__openclaw?.media).toEqual([
      {
        sourceId: "inline-video",
        sourceIndex: 0,
        contentType: "video/mp4",
        kind: "video",
      },
      {
        sourceId: "inline-image",
        sourceIndex: 1,
        contentType: "image/png",
        kind: "image",
      },
      {
        sourceId: "managed-video",
        sourceIndex: 2,
        url: "media://inbound/managed.mp4",
        contentType: "video/mp4",
        kind: "video",
      },
      {
        sourceId: "remote-video",
        sourceIndex: 3,
        url: "https://cdn.example.test/clip.mp4",
        contentType: "video/mp4",
        kind: "video",
      },
      {
        sourceId: "local-video",
        sourceIndex: 4,
        path: "/tmp/local.mp4",
        contentType: "video/mp4",
        kind: "video",
      },
      {
        sourceId: "malformed-remote-video",
        sourceIndex: 5,
        contentType: "video/mp4",
        kind: "video",
      },
    ]);
  });

  it("projects video claim checks during an exact transcript row rewrite", async () => {
    await persistMessage({ role: "user", content: "before rewrite" }, "rewrite");
    const previous = readStoredRow();
    const replacement = {
      ...previous.event,
      message: {
        role: "user",
        content: [{ type: "text", text: "rewritten" }, videoBlock],
        __openclaw: { media: [videoFact], mediaBlockFactIndexes: [0] },
      },
    };

    runOpenClawAgentWriteTransaction(
      (writeDatabase) =>
        rewriteSqliteTranscriptEventRowsInTransaction(writeDatabase, scope, [
          {
            event: replacement,
            expectedEventJson: previous.event_json,
            seq: previous.seq,
          },
        ]),
      { agentId: scope.agentId, env: scope.env },
    );

    expect(readStoredRow().event.message.content).toBe("rewritten");
    expect(replacement.message.content[1]).toBe(videoBlock);
  });
});
