import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  closeAforaAgentDatabasesForTest,
  openAforaAgentDatabase,
  runAforaAgentWriteTransaction,
} from "../../state/afora-agent-db.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { adoptLegacyMessageMetadata, parseTranscriptEventJson } from "./transcript-event-parse.js";
import { readPreferredUpstreamUserText } from "./transcript-recent-window.js";

/**
 * The rename moved the message metadata sidecar from `__openclaw` to `__afora` on the write
 * side and on all ~80 read sites in the same codemod, which is why nothing in the source
 * mismatches and no grep finds this: the third side is the data a tenant already has on disk.
 * It stayed dormant only for as long as the gateway never opened the pre-rename database.
 * The agent-database dual-read is what opens it, so this has to hold from the same release.
 */

const legacyEvent = () =>
  JSON.stringify({
    type: "message",
    id: "evt-1",
    message: {
      role: "user",
      content: [{ type: "text", text: "the raw mirrored text" }],
      __openclaw: {
        seq: 7,
        mirrorOrigin: "telegram-mirror",
        upstreamUserText: "what the person actually typed",
        media: [{ path: "/tmp/receipt.png", contentType: "image/png" }],
      },
    },
  });

describe("stored transcript events written before the rename", () => {
  it("hands the metadata sidecar to readers under the name they look for", () => {
    const event = parseTranscriptEventJson(legacyEvent()) as {
      message: Record<string, unknown>;
    };

    expect(event.message["__afora"]).toEqual({
      seq: 7,
      mirrorOrigin: "telegram-mirror",
      upstreamUserText: "what the person actually typed",
      media: [{ path: "/tmp/receipt.png", contentType: "image/png" }],
    });
    expect("__openclaw" in event.message).toBe(false);
  });

  it("keeps a pre-rename turn's upstream text, which decides what the model is shown", () => {
    const event = parseTranscriptEventJson(legacyEvent()) as {
      message: { __afora?: unknown };
    };

    expect(readPreferredUpstreamUserText(event.message)).toBe("what the person actually typed");
  });

  it("leaves a record written after the rename exactly as it is", () => {
    const parsed = parseTranscriptEventJson(
      JSON.stringify({ message: { role: "user", __afora: { seq: 2 } } }),
    ) as { message: Record<string, unknown> };

    expect(parsed.message["__afora"]).toEqual({ seq: 2 });
  });

  it("never lets the pre-rename key overwrite metadata the current one already carries", () => {
    const parsed = parseTranscriptEventJson(
      JSON.stringify({ message: { __afora: { seq: 2 }, __openclaw: { seq: 99 } } }),
    ) as { message: Record<string, unknown> };

    expect(parsed.message["__afora"]).toEqual({ seq: 2 });
  });

  it("touches nothing but the message sidecar", () => {
    const event = {
      type: "message",
      __openclaw: { notAMessageSidecar: true },
      message: { role: "assistant", content: [{ type: "text", text: "__openclaw" }] },
    };

    expect(adoptLegacyMessageMetadata(event)).toEqual(event);
  });

  it("passes through an event with no message at all", () => {
    for (const event of [undefined, null, { type: "session" }, { message: "not an object" }]) {
      expect(adoptLegacyMessageMetadata(event)).toEqual(event);
    }
  });
});

/**
 * And the same thing through the real reader, out of a real database, so this is a proof that
 * the parse funnel is on the path a tenant's stored turn actually takes and not just a unit
 * test of a pure function. The row is appended through the real writer so every foreign key
 * holds, then rewritten to the bytes a pre-rename gateway would have left behind.
 */
describe("a pre-rename turn read back out of a tenant's own database", () => {
  it("arrives with its media, its mirror origin and its sequence intact", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "afora-legacy-meta-"));
    const env = { AFORA_STATE_DIR: stateDir };
    const scope = {
      agentId: "main",
      env,
      sessionId: "sess-legacy",
      sessionKey: "agent:main:sess-legacy",
    };
    try {
      runAforaAgentWriteTransaction(
        (database) => {
          appendTranscriptEventInTransaction(database, scope, {
            id: "evt-1",
            parentId: null,
            timestamp: 1000,
            message: { role: "user", content: "placeholder" },
          });
          return undefined;
        },
        { agentId: "main", env },
      );
      const database = openAforaAgentDatabase({ agentId: "main", env });
      database.db
        .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ?")
        .run(legacyEvent(), "sess-legacy");

      const [event] = loadTranscriptEventsFromDatabase(database, "sess-legacy") as Array<{
        message: Record<string, unknown>;
      }>;

      expect(event?.message["__afora"]).toMatchObject({
        seq: 7,
        mirrorOrigin: "telegram-mirror",
        media: [{ path: "/tmp/receipt.png", contentType: "image/png" }],
      });
      expect(event?.message["__openclaw"]).toBeUndefined();
    } finally {
      closeAforaAgentDatabasesForTest();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
