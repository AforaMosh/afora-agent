import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
  preflightClientVoiceSessionResume,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let tempDir: string;

describe("client voice connection lifecycle", () => {
  beforeEach(async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-connection-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates, resumes, and enforces ownership and open state", async () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      provider: "google",
      origin: "client",
      voiceSessionId: "voice-1",
      now: 10,
    });
    expect(
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        origin: "client",
        voiceSessionId,
        now: 20,
      }),
    ).toBe(voiceSessionId);
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
    });
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
});
