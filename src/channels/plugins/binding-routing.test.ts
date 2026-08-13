// Binding routing tests cover channel binding selection and message routing behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  testing,
  registerSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import type { ResolvedAgentRoute, ResolveAgentRouteInput } from "../../routing/resolve-route.js";
import {
  ensureConfiguredBindingRouteReady,
  resolveRuntimeConversationBindingRoute,
  resolveRuntimeConversationBindingRouteWithFallback,
} from "./binding-routing.js";
import { registerStatefulBindingTargetDriver } from "./stateful-target-drivers.js";

function createRoute(): ResolvedAgentRoute {
  return {
    agentId: "main",
    channel: "demo",
    accountId: "default",
    sessionKey: "agent:main:main",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "main",
    matchedBy: "default",
  };
}

function createBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "binding-1",
    targetSessionKey: "agent:review:acp:session-1",
    targetKind: "session",
    conversation: {
      channel: "demo",
      accountId: "default",
      conversationId: "room-1",
    },
    status: "active",
    boundAt: 1,
    ...overrides,
  };
}

function registerAdapter(record: SessionBindingRecord | null): {
  resolveByConversation: ReturnType<typeof vi.fn>;
  touch: ReturnType<typeof vi.fn>;
} {
  const resolveByConversation = vi.fn<SessionBindingAdapter["resolveByConversation"]>(() => record);
  const touch = vi.fn<NonNullable<SessionBindingAdapter["touch"]>>();
  registerSessionBindingAdapter({
    channel: "demo",
    accountId: "default",
    listBySession: () => [],
    resolveByConversation,
    touch,
  });
  return { resolveByConversation, touch };
}

describe("runtime conversation binding route", () => {
  beforeEach(() => {
    testing.resetSessionBindingAdaptersForTests();
  });

  it("rewrites the route to a runtime-bound ACP session and touches the binding", () => {
    const binding = createBinding();
    const { resolveByConversation, touch } = registerAdapter(binding);

    const result = resolveRuntimeConversationBindingRoute({
      route: createRoute(),
      conversation: {
        channel: "demo",
        accountId: "default",
        conversationId: "room-1",
      },
    });

    expect(resolveByConversation).toHaveBeenCalledWith({
      channel: "demo",
      accountId: "default",
      conversationId: "room-1",
    });
    expect(touch).toHaveBeenCalledWith("binding-1", undefined);
    expect(result.boundSessionKey).toBe("agent:review:acp:session-1");
    expect(result.boundAgentId).toBe("review");
    expect(result.route).toEqual({
      agentId: "review",
      accountId: "default",
      channel: "demo",
      sessionKey: "agent:review:acp:session-1",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "binding.channel",
    });
  });

  it("resolves a core-owned binding before the fallback route", () => {
    const { resolveByConversation, touch } = registerAdapter(createBinding());
    const resolveFallbackRoute = vi.fn(createRoute);
    const routeInput = {
      cfg: {
        session: { mainKey: "home", dmScope: "main" },
        agents: { list: [{ id: "review" }, { id: "other" }] },
        bindings: [
          {
            agentId: "other",
            match: {
              channel: "demo",
              accountId: "default",
              peer: { kind: "direct", id: "room-1" },
            },
            session: { dmScope: "per-account-channel-peer" },
          },
        ],
      },
      channel: "demo",
      accountId: "default",
      peer: { kind: "direct", id: "room-1" },
    } satisfies ResolveAgentRouteInput;

    const result = resolveRuntimeConversationBindingRouteWithFallback({
      routeInput,
      conversation: {
        channel: "demo",
        accountId: "default",
        conversationId: "room-1",
      },
      resolveFallbackRoute,
    });

    expect(resolveByConversation).toHaveBeenCalledOnce();
    expect(resolveFallbackRoute).not.toHaveBeenCalled();
    expect(touch).toHaveBeenCalledWith("binding-1", undefined);
    expect(result.route).toEqual({
      agentId: "review",
      channel: "demo",
      accountId: "default",
      dmScope: "per-account-channel-peer",
      sessionKey: "agent:review:acp:session-1",
      mainSessionKey: "agent:review:home",
      lastRoutePolicy: "session",
      matchedBy: "binding.channel",
    });
  });

  it("preserves a runtime-bound agent that is absent from the current roster", () => {
    registerAdapter(createBinding());
    const resolveFallbackRoute = vi.fn(createRoute);

    const result = resolveRuntimeConversationBindingRouteWithFallback({
      routeInput: {
        cfg: { session: { mainKey: "home" }, agents: { list: [{ id: "main" }] } },
        channel: "demo",
        accountId: "default",
        peer: { kind: "direct", id: "room-1" },
      },
      conversation: { channel: "demo", accountId: "default", conversationId: "room-1" },
      resolveFallbackRoute,
    });

    expect(resolveFallbackRoute).not.toHaveBeenCalled();
    expect(result.route.agentId).toBe("review");
    expect(result.route.mainSessionKey).toBe("agent:review:home");
    expect(result.route.sessionKey).toBe("agent:review:acp:session-1");
  });

  it.each([
    ["absent", null, false],
    [
      "plugin-owned",
      createBinding({
        metadata: { pluginBindingOwner: "plugin", pluginId: "demo", pluginRoot: "/plugin" },
      }),
      true,
    ],
    ["empty", createBinding({ targetSessionKey: " " }), false],
    ["cron", createBinding({ targetSessionKey: "agent:review:cron:job:run:1" }), false],
  ] as const)("falls back once for %s bindings", (_name, binding, shouldTouch) => {
    const route = createRoute();
    const { resolveByConversation, touch } = registerAdapter(binding);
    const resolveFallbackRoute = vi.fn(() => route);

    const result = resolveRuntimeConversationBindingRouteWithFallback({
      routeInput: {
        cfg: {},
        channel: "demo",
        accountId: "default",
        peer: { kind: "direct", id: "room-1" },
      },
      conversation: { channel: "demo", accountId: "default", conversationId: "room-1" },
      resolveFallbackRoute,
    });

    expect(resolveByConversation).toHaveBeenCalledOnce();
    expect(resolveFallbackRoute).toHaveBeenCalledOnce();
    expect(touch).toHaveBeenCalledTimes(shouldTouch ? 1 : 0);
    expect(result.route).toBe(route);
  });
});

describe("ensureConfiguredBindingRouteReady", () => {
  let unregisterDriver: (() => void) | undefined;

  afterEach(() => {
    vi.useRealTimers();
    unregisterDriver?.();
  });

  it("returns a bounded failure when target readiness never settles", async () => {
    vi.useFakeTimers();
    unregisterDriver = registerStatefulBindingTargetDriver({
      id: "slow",
      ensureReady: async () => await new Promise<never>(() => {}),
      ensureSession: async () => ({
        ok: false,
        sessionKey: "agent:slow:binding",
        error: "not used",
      }),
    });

    const resultPromise = ensureConfiguredBindingRouteReady({
      cfg: {} as never,
      bindingResolution: { statefulTarget: { driverId: "slow" } } as never,
    });

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: "Configured binding route ready check timed out",
    });
  });
});
