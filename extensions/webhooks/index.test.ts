// Webhooks tests cover index plugin behavior.
import { createTestPluginApi } from "afora-agent/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { AforaPluginApi } from "./api.js";
import plugin from "./index.js";

function createApi(params?: {
  pluginConfig?: AforaPluginApi["pluginConfig"];
  registerHttpRoute?: AforaPluginApi["registerHttpRoute"];
  logger?: AforaPluginApi["logger"];
}): AforaPluginApi {
  return createTestPluginApi({
    id: "webhooks",
    name: "Webhooks",
    source: "test",
    pluginConfig: params?.pluginConfig ?? {},
    runtime: {
      tasks: {
        managedFlows: {
          bindSession: vi.fn(({ sessionKey }: { sessionKey: string }) => ({ sessionKey })),
        },
      },
    } as unknown as AforaPluginApi["runtime"],
    registerHttpRoute: params?.registerHttpRoute ?? vi.fn(),
    logger:
      params?.logger ??
      ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as AforaPluginApi["logger"]),
  });
}

function requireFirstRouteRegistration(mock: ReturnType<typeof vi.fn>) {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected webhook route registration");
  }
  return call[0] as Parameters<AforaPluginApi["registerHttpRoute"]>[0];
}

describe("webhooks plugin registration", () => {
  it("registers SecretRef-backed routes synchronously", () => {
    const registerHttpRoute = vi.fn();

    const result = plugin.register(
      createApi({
        pluginConfig: {
          routes: {
            zapier: {
              sessionKey: "agent:main:main",
              secret: {
                source: "env",
                provider: "default",
                id: "AFORA_WEBHOOK_SECRET",
              },
            },
          },
        },
        registerHttpRoute,
      }),
    );

    expect(result).toBeUndefined();
    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    const route = requireFirstRouteRegistration(registerHttpRoute);
    expect(route.path).toBe("/plugins/webhooks/zapier");
    expect(route.auth).toBe("plugin");
    expect(route.match).toBe("exact");
    expect(route.replaceExisting).toBe(true);
    expect(route.handler).toBeTypeOf("function");
  });
});
