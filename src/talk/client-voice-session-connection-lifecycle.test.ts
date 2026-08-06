import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
  preflightClientVoiceSessionResume,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let tempDir: string;
const assertConnectionClosed = () => {
  throw new Error("browser Talk connection closed during startup");
};

describe("client voice connection lifecycle", () => {
  beforeEach(async () => {
    tempDir = await fs.realpath(tempDirs.make("openclaw-voice-connection-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
  });

  it("creates, resumes, and enforces ownership and open state", async () => {
    const created = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      provider: "google",
      origin: "client",
      voiceSessionId: "voice-1",
    });
    const { voiceSessionId } = created;
    expect(created.created).toBe(true);
    expect(
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        origin: "client",
        voiceSessionId,
      }),
    ).toEqual({ voiceSessionId, created: false });
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
      provider: "google",
    });
    expect(() =>
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "openai",
        origin: "client",
        voiceSessionId,
      }),
    ).toThrow("provider does not match");
    expect(() =>
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:other",
        origin: "client",
        voiceSessionId,
      }),
    ).toThrow("does not belong");

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
      now: 30,
    });
    expect(() =>
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        origin: "client",
        voiceSessionId,
      }),
    ).toThrow("already closed");
  });

  it("preflights known resume ids without rejecting first-use ids", async () => {
    expect(() =>
      preflightClientVoiceSessionResume({
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "openai",
        origin: "client",
        voiceSessionId: "voice-first-use",
      }),
    ).not.toThrow();

    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      provider: "openai",
      origin: "client",
      voiceSessionId: "voice-known",
    }).voiceSessionId;
    expect(() =>
      preflightClientVoiceSessionResume({
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "openai",
        origin: "client",
        voiceSessionId,
      }),
    ).not.toThrow();
    expect(() =>
      preflightClientVoiceSessionResume({
        agentId: "main",
        sessionKey: "agent:main:other",
        provider: "openai",
        origin: "client",
        voiceSessionId,
      }),
    ).toThrow("does not belong");
    expect(() =>
      preflightClientVoiceSessionResume({
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "google",
        origin: "client",
        voiceSessionId,
      }),
    ).toThrow("provider does not match");

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    expect(() =>
      preflightClientVoiceSessionResume({
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "openai",
        origin: "client",
        voiceSessionId,
      }),
    ).toThrow("already closed");
  });

  it("does not commit an agent session after its browser connection closes", async () => {
    const sessionKey = "agent:main:talk:closed";
    await expect(
      ensureClientVoiceAgentSessionEntry({
        agentId: "main",
        sessionKey,
        assertCommitAllowed: assertConnectionClosed,
      }),
    ).rejects.toThrow("connection closed during startup");
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toBeUndefined();
  });

  it("does not commit a voice record after its browser connection closes", () => {
    expect(() =>
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:talk:closed",
        provider: "openai",
        origin: "client",
        voiceSessionId: "voice-closed",
        assertCommitAllowed: assertConnectionClosed,
      }),
    ).toThrow("connection closed during startup");
    expect(clientVoiceSessionTesting.readRecord("main", "voice-closed")).toBeUndefined();
  });
});
