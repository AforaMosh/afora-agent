import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import type { AgentMessage } from "../runtime/index.js";
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";
import { finalizeAcceptedContextEngineTurn } from "./context-engine-turn-attempt.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

function messageText(message: AgentMessage): unknown {
  return "content" in message ? message.content : undefined;
}

describe("accepted context-engine turn finalization", () => {
  it("advances only the admitted durable range and rejects stale admission facts", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-turn-attempt-"));
    const target = {
      agentId: "main",
      sessionId: "accepted-turn",
      sessionKey: "agent:main:accepted-turn",
      storePath: path.join(tempDir, "sessions.json"),
    };
    await upsertSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const prior = await appendTranscriptMessage(target, {
      message: { role: "assistant", content: "prior" },
      now: 1_000,
    });
    const admitted = await appendTranscriptMessage(target, {
      message: { role: "user", content: "current" },
      parentId: prior?.messageId,
      now: 2_000,
    });
    const terminal = await appendTranscriptMessage(target, {
      message: { role: "assistant", content: "answer" },
      parentId: admitted?.messageId,
      now: 3_000,
    });
    if (!admitted?.anchor || !terminal?.anchor) {
      throw new Error("expected admitted turn transcript");
    }

    const commitTurn = vi.fn(async () => ({ status: "committed" as const }));
    const engine: ContextEngine = {
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
    };
    const lease = {
      engine,
      effectiveEngine: engine,
      effectiveEngineId: "test",
      effectiveEnginePluginId: undefined,
      degraded: false,
      degradedReason: undefined,
      selectForHost: vi.fn(),
      degradeBeforeStart: vi.fn(),
      begin: vi.fn(),
      deferDisposalUntil: () => undefined,
      dispose: async () => undefined,
    } satisfies ContextEngineLogicalTurnLease;
    const admission = {
      ...admitted.anchor,
      logicalTurnId: "logical-turn-1",
      role: "user" as const,
    };
    const baseFacts = {
      boundary: { admission, terminal: terminal.anchor },
      sessionIdUsed: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      sessionFile: "sqlite://accepted-turn",
      promptError: false,
      aborted: false,
      yieldAborted: false,
    };

    await finalizeAcceptedContextEngineTurn({ facts: baseFacts, lease });

    expect(commitTurn).toHaveBeenCalledOnce();
    expect(commitTurn.mock.calls[0]?.[0].messages.map(messageText)).toEqual([
      "prior",
      "current",
      "answer",
    ]);
    expect(commitTurn.mock.calls[0]?.[0].prePromptMessageCount).toBe(1);

    const warn = vi.fn();
    await finalizeAcceptedContextEngineTurn({
      facts: {
        ...baseFacts,
        boundary: {
          ...baseFacts.boundary,
          admission: { ...admission, rawSeq: admission.rawSeq + 1 },
        },
      },
      lease,
      warn,
    });

    expect(commitTurn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[context-engine] skipped accepted turn advancement: accepted context-engine transcript range is stale",
    );
  });
});
