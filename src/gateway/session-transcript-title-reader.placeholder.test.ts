import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import { closeAforaAgentDatabasesForTest } from "../state/afora-agent-db.js";
import { closeAforaStateDatabaseForTest } from "../state/afora-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { readSessionTitleFieldsFromTranscriptBatch } from "./session-transcript-title-reader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeAforaAgentDatabasesForTest();
  closeAforaStateDatabaseForTest();
});

test("resolves placeholder store paths before batched title reads", async () => {
  const envSnapshot = captureEnv(["AFORA_STATE_DIR"]);
  const stateDir = tempDirs.make("afora-placeholder-batched-title-");
  setTestEnvValue("AFORA_STATE_DIR", stateDir);
  const sessionId = "reader-placeholder-batched-title";
  const sessionKey = `agent:main:${sessionId}`;
  const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  try {
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        messages: [
          { message: { role: "user", content: "real prompt" } },
          { message: { role: "assistant", content: "real reply" } },
        ],
        touchSessionEntry: false,
      },
    );

    expect(
      readSessionTitleFieldsFromTranscriptBatch([
        { agentId: "main", sessionId, sessionKey, storePath: "(multiple)" },
      ]),
    ).toEqual([{ firstUserMessage: "real prompt", lastMessagePreview: "real reply" }]);
  } finally {
    envSnapshot.restore();
  }
});
