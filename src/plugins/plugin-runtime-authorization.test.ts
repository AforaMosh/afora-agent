import { afterEach, describe, expect, it } from "vitest";
// Tests privileged runtime authority across plugin registry replacement.
import {
  requestDiscord,
  setDiscordProviderEndpointDescriptor,
} from "../../extensions/discord/api.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import { assertBundledPluginRuntimeCapability } from "./plugin-runtime-authorization.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

const CAPABILITY = "discord.provider-endpoint";
const FIRST_DESCRIPTOR = {
  restApiBaseUrl: "http://127.0.0.1:43123/api/v10",
  gatewayBotUrl: "http://127.0.0.1:43123/gateway/bot",
  gatewayOrigin: "ws://127.0.0.1:43124",
} as const;
const REPLACEMENT_DESCRIPTOR = {
  restApiBaseUrl: "http://127.0.0.1:43125/api/v10",
  gatewayBotUrl: "http://127.0.0.1:43125/gateway/bot",
  gatewayOrigin: "ws://127.0.0.1:43126",
} as const;

function createAuthorizedRuntime(pluginId: string) {
  const pluginRegistry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const api = pluginRegistry.createApi(
    createPluginRecord({
      id: pluginId,
      name: pluginId,
      source: `/plugins/${pluginId}/index.js`,
      origin: "bundled",
      enabled: true,
      configSchema: false,
      contracts: { privilegedRuntimeCapabilities: [CAPABILITY] },
    }),
    { config: {} as OpenClawConfig },
  );
  return { api, registry: pluginRegistry.registry };
}

async function expectDefaultDiscordRoute(): Promise<void> {
  let requestCount = 0;
  let requestedUrl: string | URL | Request | undefined;
  const fetcher: typeof fetch = async (input) => {
    requestCount += 1;
    requestedUrl = input;
    return new Response("{}", { status: 200 });
  };
  await requestDiscord("/users/@me", "test-token", { fetcher });

  expect(requestCount).toBe(1);
  expect(requestedUrl).toBe("https://discord.com/api/v10/users/@me");
}

describe("plugin runtime authorization lifecycle", () => {
  let activeRuntime: ReturnType<typeof createAuthorizedRuntime>["api"]["runtime"] | undefined;

  afterEach(() => {
    if (activeRuntime) {
      setDiscordProviderEndpointDescriptor(activeRuntime, undefined);
      activeRuntime = undefined;
    }
  });

  it("rejects a retired runtime reinstall after replacement and lets the replacement clean up", async () => {
    const first = createAuthorizedRuntime("qa-discord-endpoint");
    const replacement = createAuthorizedRuntime("qa-discord-endpoint");
    activeRuntime = replacement.api.runtime;

    markPluginRegistryActive(first.registry);
    setDiscordProviderEndpointDescriptor(first.api.runtime, FIRST_DESCRIPTOR);
    setDiscordProviderEndpointDescriptor(replacement.api.runtime, REPLACEMENT_DESCRIPTOR);
    markPluginRegistryActive(replacement.registry);
    markPluginRegistryRetired(first.registry);

    expect(() => setDiscordProviderEndpointDescriptor(first.api.runtime, FIRST_DESCRIPTOR)).toThrow(
      /runtime authorization belongs to a retired registry/,
    );

    setDiscordProviderEndpointDescriptor(replacement.api.runtime, undefined);
    activeRuntime = undefined;
    await expectDefaultDiscordRoute();
  });

  it("lets the retired active owner run its lifecycle cleanup", async () => {
    const owner = createAuthorizedRuntime("retiring-endpoint-owner");
    activeRuntime = owner.api.runtime;
    markPluginRegistryActive(owner.registry);
    setDiscordProviderEndpointDescriptor(owner.api.runtime, FIRST_DESCRIPTOR);
    markPluginRegistryRetired(owner.registry);

    expect(() => assertBundledPluginRuntimeCapability(owner.api.runtime, CAPABILITY)).toThrow(
      /runtime authorization belongs to a retired registry/,
    );
    expect(() => setDiscordProviderEndpointDescriptor(owner.api.runtime, undefined)).not.toThrow();
    activeRuntime = undefined;
    await expectDefaultDiscordRoute();
  });

  it("keeps sibling registries authorized until their own lifecycle retires", () => {
    const first = createAuthorizedRuntime("first-endpoint-owner");
    const sibling = createAuthorizedRuntime("sibling-endpoint-owner");
    markPluginRegistryActive(first.registry);
    markPluginRegistryActive(sibling.registry);

    expect(() => assertBundledPluginRuntimeCapability(first.api.runtime, CAPABILITY)).not.toThrow();
    expect(() =>
      assertBundledPluginRuntimeCapability(sibling.api.runtime, CAPABILITY),
    ).not.toThrow();

    markPluginRegistryRetired(first.registry);
    expect(() => assertBundledPluginRuntimeCapability(first.api.runtime, CAPABILITY)).toThrow(
      /runtime authorization belongs to a retired registry/,
    );
    expect(() =>
      assertBundledPluginRuntimeCapability(sibling.api.runtime, CAPABILITY),
    ).not.toThrow();
  });
});
