import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptTurnBoundary } from "../../config/sessions/transcript-entry-anchor.js";
import type { ContextEngine } from "../../context-engine/types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  drainContextEngineTurnOutbox,
  enqueueContextEngineTurnCommit,
  type ContextEngineTurnOutboxPayload,
} from "./context-engine-turn-outbox.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createPayload(params: {
  advancementKey: string;
  databasePath: string;
  sequence: number;
  sessionId: string;
}): ContextEngineTurnOutboxPayload {
  const anchor = {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: `agent:main:${params.sessionId}`,
    storePath: params.databasePath,
    generation: "generation-1",
    entryId: `${params.advancementKey}:user`,
    rawSeq: params.sequence,
    effectiveParentId: null,
    activeMessagePosition: params.sequence,
  };
  const boundary = {
    admission: {
      ...anchor,
      logicalTurnId: params.advancementKey,
      role: "user" as const,
    },
    terminal: {
      ...anchor,
      entryId: `${params.advancementKey}:assistant`,
      rawSeq: params.sequence + 1,
      effectiveParentId: anchor.entryId,
      activeMessagePosition: params.sequence + 1,
    },
  } satisfies TranscriptTurnBoundary;
  return {
    boundary,
    isHeartbeat: false,
    messages: [],
    prePromptMessageCount: params.sequence,
    sessionId: params.sessionId,
    sessionKey: anchor.sessionKey,
  };
}

describe("context-engine turn outbox", () => {
  it("does not let later same-session turns overtake a failed commit", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-outbox-order-"));
    tempDirs.push(stateDir);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const enqueue = (advancementKey: string, sessionId: string, sequence: number) =>
      enqueueContextEngineTurnCommit({
        database,
        engineId: "test",
        payload: createPayload({
          advancementKey,
          databasePath: database.path,
          sequence,
          sessionId,
        }),
      });
    enqueue("session-a:1", "session-a", 1);
    for (let turn = 2; turn <= 17; turn += 1) {
      enqueue(`session-a:${turn}`, "session-a", turn * 2 - 1);
    }
    enqueue("session-b:1", "session-b", 1);
    database.db.exec(`
      UPDATE context_engine_turn_outbox SET created_at = CASE
        WHEN session_id = 'session-a' THEN CAST(SUBSTR(advancement_key, 11) AS INTEGER)
        ELSE 100
      END;
    `);

    let failFirstTurn = true;
    const commitTurn = vi.fn(async ({ advancementKey }: { advancementKey: string }) => {
      if (advancementKey === "session-a:1" && failFirstTurn) {
        throw new Error("temporary failure");
      }
      return { status: "committed" as const };
    });
    const engine = {
      info: { id: "test", name: "Test" },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      commitTurn,
    } satisfies ContextEngine;
    const warn = vi.fn();

    await drainContextEngineTurnOutbox({
      database,
      engine,
      engineId: "test",
      warn,
    });

    expect(commitTurn.mock.calls.map(([call]) => call.advancementKey)).toEqual([
      "session-a:1",
      "session-b:1",
    ]);
    failFirstTurn = false;

    await drainContextEngineTurnOutbox({
      database,
      engine,
      engineId: "test",
      warn,
    });

    expect(commitTurn.mock.calls.map(([call]) => call.advancementKey)).toEqual([
      "session-a:1",
      "session-b:1",
      "session-a:1",
    ]);

    await drainContextEngineTurnOutbox({
      database,
      engine,
      engineId: "test",
      warn,
    });

    expect(commitTurn.mock.calls.map(([call]) => call.advancementKey)).toEqual([
      "session-a:1",
      "session-b:1",
      "session-a:1",
      "session-a:2",
    ]);
  });
});
