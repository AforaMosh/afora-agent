// Proxy capture env tests cover environment variable generation for capture sessions.
import { describe, expect, it } from "vitest";
import { resolveDebugProxySettings } from "./env.js";

const AFORA_DEBUG_PROXY_ENABLED = "AFORA_DEBUG_PROXY_ENABLED";
const AFORA_DEBUG_PROXY_SESSION_ID = "AFORA_DEBUG_PROXY_SESSION_ID";

describe("resolveDebugProxySettings", () => {
  it("keeps an implicit debug proxy session id stable within one process", () => {
    const env = {
      [AFORA_DEBUG_PROXY_ENABLED]: "1",
    } satisfies NodeJS.ProcessEnv;

    const first = resolveDebugProxySettings(env);
    const second = resolveDebugProxySettings(env);

    expect(first.sessionId).toBe(second.sessionId);
  });

  it("prefers an explicit session id from the environment", () => {
    const settings = resolveDebugProxySettings({
      [AFORA_DEBUG_PROXY_ENABLED]: "1",
      [AFORA_DEBUG_PROXY_SESSION_ID]: "session-explicit",
    });

    expect(settings.sessionId).toBe("session-explicit");
  });
});
