// OpenAI realtime auth precedence tests use the production SQLite-backed profile store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const sideEffects = vi.hoisted(() => ({
  webSocket: vi.fn(),
}));

vi.mock("ws", () => {
  class UnexpectedWebSocket {
    static readonly OPEN = 1;

    constructor(...args: unknown[]) {
      sideEffects.webSocket(...args);
      throw new Error("unexpected realtime WebSocket side effect");
    }
  }

  return { default: UnexpectedWebSocket };
});

import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const PROFILE_ID = "openai:selected";
const MODEL = "gpt-live-1-boulder-alpha";

function createConfig(agentDir: string): OpenClawConfig {
  return {
    agents: { list: [{ id: "voice", agentDir }] },
    auth: {
      profiles: {
        [PROFILE_ID]: { provider: "openai", mode: "api_key" },
      },
      order: { openai: [PROFILE_ID] },
    },
  };
}

async function expectSelectedProfileFailure(
  agentDir: string,
  expectedError: RegExp,
): Promise<void> {
  const createBrowserSession = vi.fn(async () => {
    throw new Error("unexpected realtime browser broker side effect");
  });
  const provider = buildOpenAIRealtimeVoiceProvider({
    quicksilverBrowserSessionBroker: {
      capabilities: { handlesAgentConsult: true },
      createBrowserSession,
      cancelBrowserSession: vi.fn(),
    },
  });
  const cfg = createConfig(agentDir);

  await expect(
    provider.createBrowserSession?.({
      cfg,
      providerConfig: { model: MODEL },
      model: MODEL,
      agentId: "voice",
      workspaceDir: path.join(agentDir, "workspace"),
      initialItems: [],
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
    } as never),
  ).rejects.toThrow(expectedError);

  const bridge = provider.createBridge({
    cfg,
    agentId: "voice",
    providerConfig: { model: MODEL },
    runAgentConsult: vi.fn(async () => ({ text: "Done" })),
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
  });
  await expect(bridge.connect()).rejects.toThrow(expectedError);

  expect(createBrowserSession).not.toHaveBeenCalled();
  expect(sideEffects.webSocket).not.toHaveBeenCalled();
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
}

describe("OpenAI realtime configured profile precedence", () => {
  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    sideEffects.webSocket.mockClear();
  });

  it("fails closed for an explicitly selected missing profile before realtime side effects", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-openai-realtime-auth-"));
    try {
      saveAuthProfileStore({ version: 1, profiles: {} }, agentDir, {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      });
      vi.stubEnv("OPENAI_API_KEY", "sk-ambient-must-not-be-used"); // pragma: allowlist secret
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("unexpected realtime fetch side effect");
        }),
      );

      await expectSelectedProfileFailure(agentDir, /requires an OpenAI Platform API key/u);
    } finally {
      fs.rmSync(agentDir, { force: true, recursive: true });
    }
  });

  it("fails closed for an explicitly selected unresolved ref before realtime side effects", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-openai-realtime-auth-"));
    try {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [PROFILE_ID]: {
              type: "api_key",
              provider: "openai",
              keyRef: {
                source: "env",
                provider: "default",
                id: "OPENAI_SELECTED_PROFILE_KEY",
              },
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );
      vi.stubEnv("OPENAI_SELECTED_PROFILE_KEY", "");
      vi.stubEnv("OPENAI_API_KEY", "sk-ambient-must-not-be-used"); // pragma: allowlist secret
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("unexpected realtime fetch side effect");
        }),
      );

      await expectSelectedProfileFailure(agentDir, /configured but unavailable/u);
    } finally {
      fs.rmSync(agentDir, { force: true, recursive: true });
    }
  });
});
