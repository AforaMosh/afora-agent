// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTalkTransportContext } from "./realtime-talk-shared.ts";

const transportMock = vi.hoisted(() => ({
  relayContexts: [] as RealtimeTalkTransportContext[],
  relayStops: [] as Array<ReturnType<typeof vi.fn>>,
  webRtcContexts: [] as RealtimeTalkTransportContext[],
  webRtcStops: [] as Array<ReturnType<typeof vi.fn>>,
  relayActivate: vi.fn(),
  webRtcActivate: vi.fn(),
  start: vi.fn(async (): Promise<"ready" | "cancelled"> => "ready"),
  stop: vi.fn(),
}));

vi.mock("./realtime-talk-gateway-relay.ts", () => ({
  GatewayRelayRealtimeTalkTransport: vi.fn(function (
    _session: unknown,
    context: RealtimeTalkTransportContext,
  ) {
    transportMock.relayContexts.push(context);
    const stop = vi.fn((options?: { emitClosed?: boolean }) => transportMock.stop(options));
    transportMock.relayStops.push(stop);
    return {
      start: transportMock.start,
      activate: transportMock.relayActivate,
      stop,
    };
  }),
}));
vi.mock("./realtime-talk-google-live.ts", () => ({
  GoogleLiveRealtimeTalkTransport: vi.fn(),
}));
vi.mock("./realtime-talk-webrtc.ts", () => ({
  WebRtcSdpRealtimeTalkTransport: vi.fn(function (
    _session: unknown,
    context: RealtimeTalkTransportContext,
  ) {
    transportMock.webRtcContexts.push(context);
    const stop = vi.fn((options?: { emitClosed?: boolean }) => transportMock.stop(options));
    transportMock.webRtcStops.push(stop);
    return {
      start: transportMock.start,
      activate: transportMock.webRtcActivate,
      stop,
    };
  }),
}));

import { GatewayRequestError } from "../../api/gateway.ts";
import { RealtimeTalkSession } from "./realtime-talk.ts";

const requestTimeoutOptions = { timeoutMs: 30_000 };

type TranscriptContext = RealtimeTalkTransportContext & {
  callbacks: {
    onTranscript?: (entry: { role: "user" | "assistant"; text: string; final: boolean }) => void;
  };
  flushTranscriptWrites?: () => Promise<void>;
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function transcriptContext(contexts: RealtimeTalkTransportContext[], index = 0): TranscriptContext {
  const context = contexts[index];
  if (!context) {
    throw new Error("expected realtime transport context");
  }
  return context as TranscriptContext;
}

describe("RealtimeTalkSession lifecycle", () => {
  beforeEach(() => {
    transportMock.relayContexts.length = 0;
    transportMock.relayStops.length = 0;
    transportMock.webRtcContexts.length = 0;
    transportMock.webRtcStops.length = 0;
    transportMock.relayActivate.mockClear();
    transportMock.webRtcActivate.mockClear();
    transportMock.start.mockClear();
    transportMock.stop.mockClear();
  });

  it("releases newly allocated owners after transport startup failures", async () => {
    let createCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-start-${createCount}`,
          clientSecret: "secret",
        };
      }
      return { ok: true };
    });
    const client = { request } as never;
    transportMock.start
      .mockRejectedValueOnce(new Error("first startup failed"))
      .mockRejectedValueOnce(new Error("second startup failed"));

    const first = new RealtimeTalkSession(client, "agent:main:main");
    await expect(first.start()).rejects.toThrow("first startup failed");
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(
        1,
      ),
    );

    const second = new RealtimeTalkSession(client, "agent:main:main");
    await expect(second.start()).rejects.toThrow("second startup failed");
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(
        2,
      ),
    );

    const recovered = new RealtimeTalkSession(client, "agent:main:main");
    await recovered.start();
    recovered.stop();
  });

  it("rejects a terminal failure during initial transport setup", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-terminal-startup",
          clientSecret: "secret",
        };
      }
      return { ok: true };
    });
    const onStatus = vi.fn();
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main", {
      onStatus,
    });
    transportMock.start.mockRejectedValueOnce(new Error("Realtime connection closed"));

    await expect(session.start()).rejects.toThrow("Realtime connection closed");

    expect(onStatus).toHaveBeenCalledWith("connecting");
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ emitClosed: false });
  });

  it("does not restore a failed replacement after concurrent stop", async () => {
    const replacementStart = createDeferred<"ready">();
    const transcriptEntryIds: string[] = [];
    const request = vi.fn(async (method: string, params?: { entryId?: string }) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-concurrent-stop",
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.transcript") {
        transcriptEntryIds.push(String(params?.entryId));
      }
      return { ok: true };
    });
    const client = { request } as never;
    const session = new RealtimeTalkSession(client, "agent:main:main");
    await session.start();
    const existingContext = transcriptContext(transportMock.webRtcContexts);
    transportMock.start.mockImplementationOnce(async () => await replacementStart.promise);

    const replacing = session.start();
    await vi.waitFor(() => expect(transportMock.webRtcContexts).toHaveLength(2));
    existingContext.callbacks.onTranscript?.({
      role: "user",
      text: "while replacement starts",
      final: true,
    });
    await existingContext.flushTranscriptWrites?.();
    expect(transcriptEntryIds).toEqual(["1"]);

    session.stop();
    replacementStart.reject(new Error("replacement failed after stop"));
    await expect(replacing).rejects.toThrow("replacement failed after stop");

    existingContext.callbacks.onTranscript?.({ role: "user", text: "too late", final: true });
    await Promise.resolve();
    expect(transcriptEntryIds).toEqual(["1"]);
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledOnce();
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith();
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(
        1,
      ),
    );

    const recovered = new RealtimeTalkSession(client, "agent:main:main");
    await recovered.start();
    recovered.stop();
  });

  it("aborts a failed prepared replacement without retiring the committed call", async () => {
    let createCount = 0;
    const listeners: Array<(event: { event: string; payload?: unknown }) => void> = [];
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-allocation",
          allocationId: `allocation-${createCount}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.commit") {
        return { state: "committed" };
      }
      if (method === "talk.client.abort") {
        return { state: "aborted" };
      }
      return { ok: true };
    });
    const client = {
      request,
      addEventListener: (listener: (event: { event: string; payload?: unknown }) => void) => {
        listeners.push(listener);
        return vi.fn();
      },
    } as never;
    const session = new RealtimeTalkSession(client, "agent:main:main");
    await session.start();
    transportMock.start.mockRejectedValueOnce(new Error("replacement failed"));

    await expect(session.start()).rejects.toThrow("replacement failed");

    expect(transportMock.webRtcStops[0]).not.toHaveBeenCalled();
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });
    expect(request).toHaveBeenCalledWith(
      "talk.client.abort",
      {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-allocation",
        allocationId: "allocation-2",
      },
      requestTimeoutOptions,
    );
    expect(request.mock.calls.some(([method]) => method === "talk.client.close")).toBe(false);
    session.stop();
  });

  it("stops and aborts a ready candidate when allocation commit fails", async () => {
    let createCount = 0;
    const listeners: Array<(event: { event: string; payload?: unknown }) => void> = [];
    const request = vi.fn(async (method: string, params?: { allocationId?: string }) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-commit",
          allocationId: `allocation-${createCount}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.commit" && params?.allocationId === "allocation-2") {
        throw new GatewayRequestError({ code: "INVALID_REQUEST", message: "commit failed" });
      }
      if (method === "talk.client.commit") {
        return { state: "committed" };
      }
      if (method === "talk.client.abort") {
        return { state: "aborted" };
      }
      return { ok: true };
    });
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const session = new RealtimeTalkSession(
      {
        request,
        addEventListener: (listener: (event: { event: string; payload?: unknown }) => void) => {
          listeners.push(listener);
          return vi.fn();
        },
      } as never,
      "agent:main:main",
      { onStatus, onTalkEvent },
    );
    await session.start();

    await expect(session.start()).rejects.toThrow("commit failed");

    expect(transportMock.webRtcStops[0]).not.toHaveBeenCalled();
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });
    expect(request).toHaveBeenCalledWith(
      "talk.client.abort",
      {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-commit",
        allocationId: "allocation-2",
      },
      requestTimeoutOptions,
    );
    expect(transportMock.webRtcActivate).toHaveBeenCalledOnce();

    listeners[0]?.({
      event: "talk.client.allocation.terminal",
      payload: {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-commit",
        allocationId: "allocation-1",
        outcome: "error",
        message: "active sideband failed",
      },
    });

    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith("error", "active sideband failed"),
    );
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "session.error",
      "session.closed",
    ]);
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ emitClosed: false });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "talk.client.close",
        {
          sessionKey: "agent:main:main",
          voiceSessionId: "voice-commit",
          allocationId: "allocation-1",
        },
        expect.objectContaining(requestTimeoutOptions),
      ),
    );
  });

  it("publishes a committed replacement only after retiring the old transport", async () => {
    let createCount = 0;
    const order: string[] = [];
    const request = vi.fn(async (method: string, params?: { allocationId?: string }) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-adoption-order",
          allocationId: `allocation-${createCount}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.commit") {
        if (params?.allocationId === "allocation-2") {
          order.push("commit");
        }
        return { state: "committed" };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession(
      { request, addEventListener: () => vi.fn() } as never,
      "agent:main:main",
    );
    await session.start();
    transportMock.stop.mockImplementationOnce(() => order.push("retire"));
    transportMock.webRtcActivate.mockImplementationOnce(() => order.push("activate"));

    await session.start();

    expect(order).toEqual(["commit", "retire", "activate"]);
    session.stop();
  });

  it("closes the exact committed replacement when activation fails after retirement", async () => {
    let createCount = 0;
    const request = vi.fn(async (method: string, params?: { allocationId?: string }) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-activation-failure",
          allocationId: `allocation-${createCount}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.commit" && params?.allocationId) {
        return { state: "committed" };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession(
      { request, addEventListener: () => vi.fn() } as never,
      "agent:main:main",
    );
    await session.start();
    transportMock.webRtcActivate.mockImplementationOnce(() => {
      throw new Error("activation failed");
    });

    await expect(session.start()).rejects.toThrow("activation failed");

    expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ emitClosed: false });
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });
    expect(request).toHaveBeenCalledWith(
      "talk.client.close",
      {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-activation-failure",
        allocationId: "allocation-2",
      },
      expect.objectContaining(requestTimeoutOptions),
    );
    expect(
      request.mock.calls.some(
        ([method, params]) =>
          method === "talk.client.close" && params?.allocationId === "allocation-1",
      ),
    ).toBe(false);
  });

  it("does not retain a provider-closed candidate discovered after deferred commit", async () => {
    const replacementCommit = createDeferred<{ state: "committed" }>();
    let createCount = 0;
    const request = vi.fn(async (method: string, params?: { allocationId?: string }) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-provider-close",
          allocationId: `allocation-${createCount}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.commit" && params?.allocationId === "allocation-2") {
        return await replacementCommit.promise;
      }
      if (method === "talk.client.commit") {
        return { state: "committed" };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession(
      { request, addEventListener: () => vi.fn() } as never,
      "agent:main:main",
    );
    await session.start();
    transportMock.webRtcActivate.mockImplementationOnce(() => {
      throw new Error("provider closed during commit");
    });

    const replacing = session.start();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "talk.client.commit",
        {
          sessionKey: "agent:main:main",
          voiceSessionId: "voice-provider-close",
          allocationId: "allocation-2",
        },
        requestTimeoutOptions,
      ),
    );
    replacementCommit.resolve({ state: "committed" });

    await expect(replacing).rejects.toThrow("provider closed during commit");
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledOnce();
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "talk.client.close",
      {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-provider-close",
        allocationId: "allocation-2",
      },
      expect.objectContaining(requestTimeoutOptions),
    );

    session.stop();
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledOnce();
  });

  it("retries an ambiguous commit once, then closes both possible owners", async () => {
    let createCount = 0;
    const request = vi.fn(async (method: string, params?: { allocationId?: string }) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-ambiguous",
          allocationId: `allocation-${createCount}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.commit" && params?.allocationId === "allocation-2") {
        throw new Error("socket closed before acknowledgement");
      }
      return { state: "committed" };
    });
    const onStatus = vi.fn();
    const session = new RealtimeTalkSession(
      { request, addEventListener: () => vi.fn() } as never,
      "agent:main:main",
      { onStatus },
    );
    await session.start();

    await expect(session.start()).rejects.toThrow(
      "Realtime Talk allocation commit could not be confirmed",
    );

    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "talk.client.commit" &&
          (params as { allocationId?: string })?.allocationId === "allocation-2",
      ),
    ).toHaveLength(2);
    expect(
      request.mock.calls.some(
        ([method, params]) =>
          method === "talk.client.abort" &&
          (params as { allocationId?: string })?.allocationId === "allocation-2",
      ),
    ).toBe(false);
    expect(
      request.mock.calls
        .filter(([method]) => method === "talk.client.close")
        .map(([, params]) => (params as { allocationId?: string }).allocationId)
        .toSorted((left, right) => String(left).localeCompare(String(right))),
    ).toEqual(["allocation-1", "allocation-2"]);
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ emitClosed: false });
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });
    expect(onStatus).toHaveBeenCalledWith(
      "error",
      "Realtime Talk allocation commit could not be confirmed",
    );
  });

  it("buffers candidate finals until commit acknowledgement", async () => {
    const ready = createDeferred<"ready">();
    const requestOrder: string[] = [];
    const request = vi.fn(async (method: string) => {
      requestOrder.push(method);
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-buffered",
          allocationId: "allocation-buffered",
          clientSecret: "secret",
        };
      }
      return { state: "committed" };
    });
    const onTranscript = vi.fn();
    const session = new RealtimeTalkSession(
      { request, addEventListener: () => vi.fn() } as never,
      "agent:main:main",
      { onTranscript },
    );
    transportMock.start.mockImplementationOnce(async () => await ready.promise);

    const starting = session.start();
    await vi.waitFor(() => expect(transportMock.webRtcContexts).toHaveLength(1));
    const context = transcriptContext(transportMock.webRtcContexts);
    context.callbacks.onTranscript?.({ role: "user", text: "before commit", final: true });
    expect(onTranscript).not.toHaveBeenCalled();
    expect(requestOrder).not.toContain("talk.client.transcript");

    ready.resolve("ready");
    await starting;
    await context.flushTranscriptWrites?.();

    expect(onTranscript).toHaveBeenCalledWith({
      role: "user",
      text: "before commit",
      final: true,
    });
    expect(requestOrder.indexOf("talk.client.commit")).toBeLessThan(
      requestOrder.indexOf("talk.client.transcript"),
    );
    session.stop();
  });

  it("flushes a terminal initial candidate before acknowledging close", async () => {
    const ready = createDeferred<"ready">();
    const listeners: Array<(event: { event: string; payload?: unknown }) => void> = [];
    let terminal = false;
    const requestOrder: string[] = [];
    const request = vi.fn(async (method: string) => {
      requestOrder.push(method);
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-terminal-candidate",
          allocationId: "allocation-terminal-candidate",
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.commit") {
        return terminal
          ? {
              state: "terminal",
              terminal: { outcome: "error", message: "provider startup failed" },
            }
          : { state: "committed" };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession(
      {
        request,
        addEventListener: (listener: (event: { event: string; payload?: unknown }) => void) => {
          listeners.push(listener);
          return vi.fn();
        },
      } as never,
      "agent:main:main",
    );
    transportMock.start.mockImplementationOnce(async () => await ready.promise);

    const starting = session.start();
    await vi.waitFor(() => expect(transportMock.webRtcContexts).toHaveLength(1));
    transcriptContext(transportMock.webRtcContexts).callbacks.onTranscript?.({
      role: "user",
      text: "save before close",
      final: true,
    });
    terminal = true;
    listeners[0]?.({
      event: "talk.client.allocation.terminal",
      payload: {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-terminal-candidate",
        allocationId: "allocation-terminal-candidate",
        outcome: "completed",
      },
    });
    ready.resolve("ready");
    await starting;

    expect(requestOrder.indexOf("talk.client.transcript")).toBeLessThan(
      requestOrder.indexOf("talk.client.close"),
    );
  });

  it("preserves the active transport when a prepared replacement is already terminal", async () => {
    let createCount = 0;
    const onTalkEvent = vi.fn();
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-create-terminal",
          allocationId: `allocation-${createCount}`,
          clientSecret: "secret",
          ...(createCount === 2
            ? {
                terminal: {
                  outcome: "error",
                  message: "provider failed before transport startup",
                },
              }
            : {}),
        };
      }
      if (method === "talk.client.commit") {
        return { state: "committed" };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession(
      { request, addEventListener: () => vi.fn() } as never,
      "agent:main:main",
      { onTalkEvent },
    );
    await session.start();

    await session.start();

    expect(transportMock.webRtcContexts).toHaveLength(1);
    expect(transportMock.webRtcStops[0]).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "talk.client.close",
      {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-create-terminal",
        allocationId: "allocation-2",
      },
      requestTimeoutOptions,
    );
    expect(onTalkEvent).not.toHaveBeenCalled();
    session.stop();
  });

  it("projects a replacement terminal once only after commit adopts it", async () => {
    const replacementCommit = createDeferred<{ state: "committed" }>();
    const listeners: Array<(event: { event: string; payload?: unknown }) => void> = [];
    let createCount = 0;
    const request = vi.fn(async (method: string, params?: { allocationId?: string }) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-terminal-adoption",
          allocationId: `allocation-${createCount}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.commit" && params?.allocationId === "allocation-2") {
        return await replacementCommit.promise;
      }
      if (method === "talk.client.commit") {
        return { state: "committed" };
      }
      return { ok: true };
    });
    const onTalkEvent = vi.fn();
    const session = new RealtimeTalkSession(
      {
        request,
        addEventListener: (listener: (event: { event: string; payload?: unknown }) => void) => {
          listeners.push(listener);
          return vi.fn();
        },
      } as never,
      "agent:main:main",
      { onTalkEvent },
    );
    await session.start();

    const replacing = session.start();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "talk.client.commit",
        {
          sessionKey: "agent:main:main",
          voiceSessionId: "voice-terminal-adoption",
          allocationId: "allocation-2",
        },
        requestTimeoutOptions,
      ),
    );
    listeners[1]?.({
      event: "talk.client.allocation.terminal",
      payload: {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-terminal-adoption",
        allocationId: "allocation-2",
        outcome: "error",
        message: "sideband failed during commit",
      },
    });
    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(transportMock.webRtcStops[0]).not.toHaveBeenCalled();

    replacementCommit.resolve({ state: "committed" });
    await replacing;

    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "session.error",
      "session.closed",
    ]);
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ emitClosed: false });
  });

  it("fails closed when allocation commit returns an unrecognized acknowledgement", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-invalid-commit",
          allocationId: "allocation-invalid-commit",
          clientSecret: "secret",
        };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession(
      { request, addEventListener: () => vi.fn() } as never,
      "agent:main:main",
    );

    await expect(session.start()).rejects.toThrow(
      "Realtime Talk allocation commit returned an invalid result",
    );

    expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ emitClosed: false });
    expect(request).toHaveBeenCalledWith(
      "talk.client.close",
      {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-invalid-commit",
        allocationId: "allocation-invalid-commit",
      },
      requestTimeoutOptions,
    );
  });

  it("filters terminal events by allocation and sequences the active terminal once", async () => {
    let createCount = 0;
    const listeners: Array<(event: { event: string; payload?: unknown }) => void> = [];
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-terminal",
          allocationId: `allocation-${createCount}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.commit") {
        return { state: "committed" };
      }
      return { ok: true };
    });
    const addEventListener = vi.fn(
      (listener: (event: { event: string; payload?: unknown }) => void) => {
        listeners.push(listener);
        const dispose = vi.fn();
        disposers.push(dispose);
        return dispose;
      },
    );
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const session = new RealtimeTalkSession(
      { request, addEventListener } as never,
      "agent:main:main",
      { onStatus, onTalkEvent },
    );
    await session.start();
    await session.start();

    listeners[0]?.({
      event: "talk.client.allocation.terminal",
      payload: {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-terminal",
        allocationId: "allocation-1",
        outcome: "completed",
      },
    });
    listeners[1]?.({
      event: "talk.client.allocation.terminal",
      payload: {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-terminal",
        allocationId: "other",
        outcome: "error",
        message: "wrong",
      },
    });
    listeners[1]?.({
      event: "talk.client.allocation.terminal",
      payload: {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-terminal",
        allocationId: "allocation-2",
        outcome: "error",
        message: "sideband failed",
      },
    });

    await vi.waitFor(() => expect(onTalkEvent).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("error", "sideband failed"));
    expect(addEventListener).toHaveBeenCalledTimes(2);
    expect(disposers[0]).toHaveBeenCalledOnce();
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "session.error",
      "session.closed",
    ]);
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });
    expect(request).toHaveBeenCalledWith(
      "talk.client.close",
      {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-terminal",
        allocationId: "allocation-2",
      },
      expect.objectContaining(requestTimeoutOptions),
    );
  });
});
