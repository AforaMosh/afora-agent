import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { readSessionCompanionSeedMessages } from "./session-companion-seed.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("session companion transcript seed", () => {
  it("reads a bounded active SQLite tail without decoding old transcript rows", async () => {
    const stateDir = tempDirs.make("openclaw-companion-seed-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "companion-seed-test",
      sessionKey: "agent:main:companion-seed-test",
    };
    const messages = Array.from({ length: 201 }, (_, index) => ({
      eventId: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      message: {
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `message ${index}`,
        timestamp: index,
      },
    }));
    await persistSessionTranscriptTurn(scope, { messages, touchSessionEntry: false });

    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    database.db
      .prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 1")
      .run(scope.sessionId);

    const seed = readSessionCompanionSeedMessages(scope);

    expect(seed).toHaveLength(40);
    expect(seed.at(0)).toEqual({ role: "user", text: "message 160", ts: 160 });
    expect(seed.at(-1)).toEqual({ role: "assistant", text: "message 199", ts: 199 });
    expect(seed.some((message) => message.text === "message 200")).toBe(false);
  });

  it("pages past a tool-heavy tail to preserve older seedable context", async () => {
    const stateDir = tempDirs.make("openclaw-companion-tool-tail-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "companion-tool-tail-test",
      sessionKey: "agent:main:companion-tool-tail-test",
    };
    const usefulMessages = Array.from({ length: 50 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `useful ${index}`,
      timestamp: index,
    }));
    const toolMessages = Array.from({ length: 400 }, (_, index) => ({
      role: "toolResult" as const,
      content: `tool result ${index}`,
      timestamp: usefulMessages.length + index,
    }));
    const transcriptMessages = [
      ...usefulMessages,
      ...toolMessages,
      { role: "user" as const, content: "current question", timestamp: 450 },
    ].map((message, index) => ({
      eventId: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      message,
    }));
    await persistSessionTranscriptTurn(scope, {
      messages: transcriptMessages,
      touchSessionEntry: false,
    });

    const seed = readSessionCompanionSeedMessages(scope);

    expect(seed).toHaveLength(40);
    expect(seed.at(0)).toEqual({ role: "user", text: "useful 10", ts: 10 });
    expect(seed.at(-1)).toEqual({ role: "assistant", text: "useful 49", ts: 49 });
    expect(seed.some((message) => message.text === "current question")).toBe(false);
    expect(seed.some((message) => message.text.startsWith("tool result"))).toBe(false);
  });
});
