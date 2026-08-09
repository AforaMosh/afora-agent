import { describe, expect, it, vi } from "vitest";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { getBoundChannelInboundMemorySubjectIssuer } from "../channels/inbound-event/memory-subject-attestation.js";
import type { RecordInboundSession } from "../channels/session.types.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createPluginRuntimeResolver } from "./registry-runtime.js";
import { createPluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";

const PLUGIN_ID = "test-channel-owner";
const CHANNEL_ID = "test";
const SESSION_KEY = "agent:main:test:direct:sender-1";

function createPluginRecord(): PluginRecord {
  return {
    id: PLUGIN_ID,
    name: "Test Channel Owner",
    source: "test",
    origin: "bundled",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [CHANNEL_ID],
    cliBackendIds: [],
    providerIds: [],
    embeddingProviderIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    transcriptSourceProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    migrationProviderIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  };
}

function createFixture(params: { activate?: boolean } = {}) {
  const runtime = createPluginRuntime();
  const state = createPluginRegistryState({
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    runtime,
  });
  const record = createPluginRecord();
  state.registry.plugins.push(record);
  state.registry.channels.push({
    pluginId: PLUGIN_ID,
    source: "test",
    plugin: { id: CHANNEL_ID },
  } as never);
  if (params.activate !== false) {
    markPluginRegistryActive(state.registry);
  }
  const resolver = createPluginRuntimeResolver(state);
  resolver.setPluginRuntimeRecord(record);
  return {
    record,
    registry: state.registry,
    inbound: resolver.resolvePluginRuntime(PLUGIN_ID).channel.inbound,
  };
}

function buildContext(inbound: PluginRuntime["channel"]["inbound"]): FinalizedMsgContext {
  return inbound.buildContext({
    channel: CHANNEL_ID,
    accountId: "acct",
    from: "test:sender-1",
    sender: { id: "sender-1" },
    conversation: { kind: "direct", id: "sender-1" },
    route: {
      agentId: "main",
      accountId: "acct",
      dmScope: "per-channel-peer",
      routeSessionKey: SESSION_KEY,
    },
    reply: { to: "test:sender-1" },
    message: { rawBody: "hello" },
  });
}

async function observeIssuer(params: {
  ctx: FinalizedMsgContext;
  inbound: PluginRuntime["channel"]["inbound"];
}): Promise<unknown> {
  let issuer: unknown;
  const recordInboundSession = vi.fn<RecordInboundSession>(async (record) => {
    issuer = getBoundChannelInboundMemorySubjectIssuer(
      record.ctx as FinalizedMsgContext,
      record.sessionKey,
    );
  });
  await params.inbound.run({
    channel: CHANNEL_ID,
    accountId: "acct",
    raw: {},
    adapter: {
      ingest: () => ({ id: "message-1", rawText: "hello" }),
      resolveTurn: () => ({
        channel: CHANNEL_ID,
        accountId: "acct",
        routeSessionKey: SESSION_KEY,
        storePath: "/tmp/openclaw-registry-runtime-inbound-liveness",
        ctxPayload: params.ctx,
        recordInboundSession,
        runDispatch: async () => ({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }),
        runDispatchLifecycle: {
          turnAdoptionLifecycle: undefined,
          onDispatchSkipped: async () => undefined,
        },
      }),
    },
  } as never);
  return issuer;
}

describe("plugin runtime inbound facade liveness", () => {
  it("issues only while the live registry owns an activated, loaded, enabled channel", async () => {
    const active = createFixture();

    expect(
      await observeIssuer({ ctx: buildContext(active.inbound), inbound: active.inbound }),
    ).toBeDefined();
  });

  it.each([
    ["disabled", (fixture: ReturnType<typeof createFixture>) => (fixture.record.enabled = false)],
    [
      "unloaded",
      (fixture: ReturnType<typeof createFixture>) => (fixture.record.status = "disabled"),
    ],
    [
      "removed",
      (fixture: ReturnType<typeof createFixture>) => fixture.registry.plugins.splice(0, 1),
    ],
    [
      "retired",
      (fixture: ReturnType<typeof createFixture>) => markPluginRegistryRetired(fixture.registry),
    ],
    [
      "without its registered channel",
      (fixture: ReturnType<typeof createFixture>) => fixture.registry.channels.splice(0, 1),
    ],
  ])("revokes authority when the plugin is %s", async (_label, revoke) => {
    const fixture = createFixture();
    const ctx = buildContext(fixture.inbound);
    revoke(fixture);

    expect(await observeIssuer({ ctx, inbound: fixture.inbound })).toBeUndefined();
  });

  it("rejects a registry that was never activated", async () => {
    const fixture = createFixture({ activate: false });

    expect(
      await observeIssuer({ ctx: buildContext(fixture.inbound), inbound: fixture.inbound }),
    ).toBeUndefined();
  });
});
