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
    if (!admitted?.admission || !terminal) {
      throw new Error("expected admitted turn transcript");
    }

    const afterTurn = vi.fn(async () => undefined);
    const engine: ContextEngine = {
      info: { id: "test", name: "Test" },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      afterTurn,
    };
    const lease = {
      engine,
      effectiveEngine: engine,
      effectiveEnginePluginId: undefined,
      degraded: false,
      deferDisposalUntil: () => undefined,
      dispose: async () => undefined,
    } satisfies ContextEngineLogicalTurnLease;
    const baseFacts = {
      admission: admitted.admission,
      terminalEntryId: terminal.messageId,
      sessionIdUsed: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      sessionFile: "sqlite://accepted-turn",
      promptError: false,
      aborted: false,
      yieldAborted: false,
    };

    await finalizeAcceptedContextEngineTurn({ facts: baseFacts, lease });

    expect(afterTurn).toHaveBeenCalledOnce();
    expect(afterTurn.mock.calls[0]?.[0].messages.map(messageText)).toEqual([
      "prior",
      "current",
      "answer",
    ]);
    expect(afterTurn.mock.calls[0]?.[0].prePromptMessageCount).toBe(1);

    const warn = vi.fn();
    await finalizeAcceptedContextEngineTurn({
      facts: {
        ...baseFacts,
        admission: { ...admitted.admission, rawSeq: admitted.admission.rawSeq + 1 },
      },
      lease,
      warn,
    });

    expect(afterTurn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[context-engine] skipped accepted turn advancement: accepted context-engine transcript admission is stale",
    );
  });
});
