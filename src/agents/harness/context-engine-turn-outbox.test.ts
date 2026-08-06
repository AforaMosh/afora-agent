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
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";
import { drainPendingContextEngineTurnsBeforeRun } from "./context-engine-turn-attempt.js";
import {
  drainContextEngineTurnOutbox,
  enqueueContextEngineTurnCommit,
} from "./context-engine-turn-outbox.js";

const tempDirs: string[] = [];
type ContextEngineTurnOutboxPayload = Parameters<
  typeof enqueueContextEngineTurnCommit
>[0]["payload"];

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
    enqueue("session-a:z-first", "session-a", 1);
    for (let turn = 2; turn <= 17; turn += 1) {
      enqueue(turn === 2 ? "session-a:a-second" : `session-a:${turn}`, "session-a", turn * 2 - 1);
    }
    enqueue("session-b:1", "session-b", 1);
    database.db.exec(`
      UPDATE context_engine_turn_outbox SET created_at = CASE
        WHEN session_id = 'session-a' THEN 1
        ELSE 100
      END;
    `);

    let failFirstTurn = true;
    const commitTurn = vi.fn(async ({ advancementKey }: { advancementKey: string }) => {
      if (advancementKey === "session-a:z-first" && failFirstTurn) {
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
      "session-a:z-first",
      "session-b:1",
    ]);
    failFirstTurn = false;

    await drainContextEngineTurnOutbox({
      database,
      engine,
      engineId: "test",
      limit: 2,
      warn,
    });

    expect(commitTurn.mock.calls.map(([call]) => call.advancementKey)).toEqual([
      "session-a:z-first",
      "session-b:1",
      "session-a:z-first",
      "session-a:a-second",
    ]);

    await drainContextEngineTurnOutbox({
      database,
      engine,
      engineId: "test",
      limit: 1,
      warn,
    });

    expect(commitTurn.mock.calls.map(([call]) => call.advancementKey)).toEqual([
      "session-a:z-first",
      "session-b:1",
      "session-a:z-first",
      "session-a:a-second",
      "session-a:3",
    ]);
  });

  it("retries the current session before the next run and degrades if it stays blocked", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-outbox-retry-"));
    tempDirs.push(stateDir);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const payload = createPayload({
      advancementKey: "session-a:retry",
      databasePath: database.path,
      sequence: 1,
      sessionId: "session-a",
    });
    enqueueContextEngineTurnCommit({ database, engineId: "test", payload });

    let blocked = true;
    const commitTurn = vi.fn(async () => {
      if (blocked) {
        throw new Error("temporary failure");
      }
      return { status: "committed" as const };
    });
    const engine = {
      info: {
        id: "test",
        name: "Test",
        transcriptSemantics: {
          currentTurnFence: "before-current-turn-entry-v1",
          turnAdvancementIdempotency: "atomic-idempotent-v1",
        },
      },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      commitTurn,
    } satisfies ContextEngine;
    const degradeBeforeStart = vi.fn();
    const lease = {
      engine,
      effectiveEngine: engine,
      effectiveEngineId: "test",
      effectiveEnginePluginId: undefined,
      degraded: false,
      degradedReason: undefined,
      selectForHost: vi.fn(),
      degradeBeforeStart,
      begin: vi.fn(),
      deferDisposalUntil: vi.fn(),
      dispose: vi.fn(async () => undefined),
    } satisfies ContextEngineLogicalTurnLease;
    const warn = vi.fn();

    await drainContextEngineTurnOutbox({ database, engine, engineId: "test", warn });
    blocked = false;
    await drainPendingContextEngineTurnsBeforeRun({
      admission: payload.boundary.admission,
      lease,
      warn,
    });

    expect(commitTurn).toHaveBeenCalledTimes(2);
    expect(degradeBeforeStart).not.toHaveBeenCalled();

    enqueueContextEngineTurnCommit({
      database,
      engineId: "test",
      payload: createPayload({
        advancementKey: "session-a:blocked",
        databasePath: database.path,
        sequence: 3,
        sessionId: "session-a",
      }),
    });
    blocked = true;
    await drainPendingContextEngineTurnsBeforeRun({
      admission: payload.boundary.admission,
      lease,
      warn,
    });

    expect(degradeBeforeStart).toHaveBeenCalledWith(
      "pending durable turn advancement could not be completed before the next turn",
    );
  });
});
