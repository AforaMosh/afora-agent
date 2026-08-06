// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  RealtimeTalkCallbacks,
  RealtimeTalkTransportContext,
} from "./realtime-talk-shared.ts";

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
const closeRequestTimeoutOptions = { timeoutMs: 9_166 };

type TranscriptContext = RealtimeTalkTransportContext & {
  callbacks: {
    onTranscript?: (entry: { role: "user" | "assistant"; text: string; final: boolean }) => void;
  };
  flushTranscriptWrites?: () => Promise<void>;
};
type GatewayRequestArgs = Parameters<GatewayBrowserClient["request"]>;

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

  it("waits for exact close before releasing an allocation after transport stop throws", async () => {
    const firstClose = createDeferred<void>();
    let createCount = 0;
    const request = vi.fn(async (method: string, params?: { allocationId?: string }) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-stop-${createCount}`,
          allocationId: `allocation-${createCount}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.commit") {
        return { state: "committed" };
      }
      if (method === "talk.client.close" && params?.allocationId === "allocation-1") {
        await firstClose.promise;
      }
      return { ok: true };
    });
    const onStatus = vi.fn();
    const client = { request, addEventListener: () => vi.fn() } as never;
    const session = new RealtimeTalkSession(client, "agent:main:stop-error", { onStatus });
    await session.start();
    const transportError = new Error("transport stop failed");
    transportMock.stop.mockImplementationOnce(() => {
      throw transportError;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      session.stop();
      expect(onStatus).toHaveBeenLastCalledWith("idle");
      expect(transportMock.webRtcStops[0]).toHaveBeenCalledOnce();
      await vi.waitFor(() =>
        expect(
          request.mock.calls.filter(
            ([method, params]) =>
              method === "talk.client.close" && params?.allocationId === "allocation-1",
          ),
        ).toHaveLength(1),
      );
      expect(warn).not.toHaveBeenCalledWith(transportError);

      await session.start();
      const third = new RealtimeTalkSession(client, "agent:main:stop-error");
      await expect(third.start()).rejects.toThrow(
        "Too many active or closing realtime Talk voice sessions",
      );

      firstClose.resolve();
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(transportError));
      await third.start();
      expect(createCount).toBe(3);
      expect(unhandled).not.toHaveBeenCalled();
      expect(
        request.mock.calls.filter(
          ([method, params]) =>
            method === "talk.client.close" && params?.allocationId === "allocation-1",
        ),
      ).toHaveLength(1);

      session.stop();
      third.stop();
      await vi.waitFor(() =>
        expect(
          request.mock.calls.filter(([method]) => method === "talk.client.close"),
        ).toHaveLength(3),
      );
    } finally {
      process.off("unhandledRejection", unhandled);
      warn.mockRestore();
    }
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

  it.each(["error", "completed"] as const)(
    "orders an initial %s terminal before startup and cleanup failures",
    async (outcome) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const listeners: Array<(event: { event: string; payload?: unknown }) => void> = [];
        let closeAttempts = 0;
        const request = vi.fn(async (method: string) => {
          if (method === "talk.client.create") {
            return {
              provider: "openai",
              transport: "webrtc",
              voiceSessionId: "voice-terminal-start-order",
              allocationId: "allocation-terminal-start-order",
              clientSecret: "secret",
            };
          }
          if (method === "talk.client.close") {
            closeAttempts += 1;
            throw new Error("terminal cleanup failed");
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
        transportMock.start.mockImplementationOnce(async () => {
          listeners[0]?.({
            event: "talk.client.allocation.terminal",
            payload: {
              allocationId: "allocation-terminal-start-order",
              outcome,
              ...(outcome === "error" ? { message: "provider startup failed" } : {}),
            },
          });
          throw new Error("transport startup failed");
        });

        const starting = session.start();
        await vi.advanceTimersByTimeAsync(2_500);
        await expect(starting).rejects.toThrow(
          outcome === "error" ? "provider startup failed" : "transport startup failed",
        );

        expect(closeAttempts).toBe(3);
        expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual(
          outcome === "error" ? ["session.error", "session.closed"] : [],
        );
        expect(onStatus.mock.calls).toEqual(
          outcome === "error"
            ? [["connecting"], ["error", "provider startup failed"]]
            : [["connecting"]],
        );
        expect(warn).toHaveBeenCalledWith(
          "Realtime Talk terminal cleanup failed",
          expect.any(Error),
        );
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("projects an initially completed allocation as a global terminal", async () => {
    const closed = createDeferred<void>();
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-completed-startup",
          allocationId: "allocation-completed-startup",
          clientSecret: "secret",
          terminal: { outcome: "completed" },
        };
      }
      if (method === "talk.client.close") await closed.promise;
      return { ok: true };
    });
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const session = new RealtimeTalkSession(
      { request, addEventListener: () => vi.fn() } as never,
      "agent:main:main",
      { onStatus, onTalkEvent },
    );

    const starting = session.start();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "talk.client.close",
        expect.anything(),
        expect.anything(),
      ),
    );

    expect(transportMock.webRtcContexts).toHaveLength(0);
    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(onStatus.mock.calls.map(([status]) => status)).toEqual(["connecting"]);
    closed.resolve();
    await starting;
    expect(request).toHaveBeenCalledWith(
      "talk.client.close",
      {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-completed-startup",
        allocationId: "allocation-completed-startup",
      },
      expect.objectContaining(closeRequestTimeoutOptions),
    );
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual(["session.closed"]);
    expect(onStatus.mock.calls.map(([status]) => status)).toEqual(["connecting", "idle"]);
  });

  it("rejects a completed terminal when exact cleanup fails", async () => {
    vi.useFakeTimers();
    try {
      let closeAttempts = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.create") {
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-completed-cleanup",
            allocationId: "allocation-completed-cleanup",
            clientSecret: "secret",
            terminal: { outcome: "completed" },
          };
        }
        if (method === "talk.client.close") {
          closeAttempts += 1;
          throw new Error("terminal close unavailable");
        }
        return { ok: true };
      });
      const onStatus = vi.fn();
      const onTalkEvent = vi.fn();
      const session = new RealtimeTalkSession(
        { request, addEventListener: () => vi.fn() } as never,
        "agent:main:main",
        { onStatus, onTalkEvent },
      );

      const starting = session.start();
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(starting).rejects.toThrow("terminal close unavailable");

      expect(closeAttempts).toBe(3);
      expect(onTalkEvent).not.toHaveBeenCalled();
      expect(onStatus.mock.calls.map(([status]) => status)).toEqual(["connecting"]);
    } finally {
      vi.useRealTimers();
    }
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

  it("surfaces candidate abort failure after clean startup cancellation", async () => {
    const abortError = new Error("candidate abort failed");
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-cancel-abort",
          allocationId: "allocation-cancel-abort",
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.abort") throw abortError;
      return { ok: true };
    });
    const session = new RealtimeTalkSession(
      { request, addEventListener: () => vi.fn() } as never,
      "agent:main:main",
    );
    transportMock.start.mockResolvedValueOnce("cancelled");

    await expect(session.start()).rejects.toBe(abortError);

    expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ emitClosed: false });
    expect(request.mock.calls.some(([method]) => method === "talk.client.close")).toBe(false);
  });

  it("preserves startup failure when candidate abort also fails", async () => {
    const startupError = new Error("transport startup failed");
    const abortError = new Error("candidate abort failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.create") {
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-startup-abort",
            allocationId: "allocation-startup-abort",
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.abort") throw abortError;
        return { ok: true };
      });
      const session = new RealtimeTalkSession(
        { request, addEventListener: () => vi.fn() } as never,
        "agent:main:main",
      );
      transportMock.start.mockRejectedValueOnce(startupError);

      await expect(session.start()).rejects.toBe(startupError);

      expect(warn).toHaveBeenCalledWith(abortError);
      expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ emitClosed: false });
    } finally {
      warn.mockRestore();
    }
  });

  it("aborts only the candidate when allocation commit fails before send", async () => {
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

    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "talk.client.commit" && params?.allocationId === "allocation-2",
      ),
    ).toHaveLength(1);
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
        expect.objectContaining(closeRequestTimeoutOptions),
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
    const onStatus = vi.fn();
    const session = new RealtimeTalkSession(
      { request, addEventListener: () => vi.fn() } as never,
      "agent:main:main",
      { onStatus },
    );
    await session.start();
    transportMock.stop.mockImplementationOnce(() => order.push("retire"));
    transportMock.webRtcActivate.mockImplementationOnce(() => order.push("activate"));

    await session.start();

    expect(order).toEqual(["commit", "retire", "activate"]);
    expect(onStatus.mock.calls.map(([status]) => status)).toEqual(["connecting"]);
    session.stop();
  });

  it.each([
    ["previous disposer", true, false],
    ["old transport", false, true],
    ["previous disposer before old transport", true, true],
  ])(
    "retires the published candidate after %s cleanup fails",
    async (_label, disposerThrows, oldStopThrows) => {
      let createCount = 0;
      const disposerError = new Error("previous disposer failed");
      const oldStopError = new Error("old transport stop failed");
      const disposers: Array<ReturnType<typeof vi.fn>> = [];
      const request = vi.fn(
        async (
          ...[method]: [method: GatewayRequestArgs[0], params?: { allocationId?: string }]
        ) => {
          if (method === "talk.client.create") {
            createCount += 1;
            return {
              provider: "openai",
              transport: "webrtc",
              voiceSessionId: "voice-replacement-cleanup",
              allocationId: `allocation-${createCount}`,
              clientSecret: "secret",
            };
          }
          if (method === "talk.client.commit") {
            return { state: "committed" };
          }
          return { ok: true };
        },
      );
      const onTranscript = vi.fn();
      const session = new RealtimeTalkSession(
        {
          request,
          addEventListener: () => {
            const isPrevious = disposers.length === 0;
            const dispose = vi.fn(() => {
              if (isPrevious && disposerThrows) throw disposerError;
            });
            disposers.push(dispose);
            return dispose;
          },
        } as never,
        "agent:main:main",
        { onTranscript },
      );
      await session.start();
      if (oldStopThrows) {
        transportMock.stop.mockImplementationOnce(() => {
          throw oldStopError;
        });
      }
      transportMock.start.mockImplementationOnce(async () => {
        transcriptContext(transportMock.webRtcContexts, 1).callbacks.onTranscript?.({
          role: "user",
          text: "candidate adopted during cleanup",
          final: true,
        });
        return "ready";
      });

      let failure: unknown;
      try {
        await session.start();
      } catch (error) {
        failure = error;
      }

      expect(failure).toBe(disposerThrows ? disposerError : oldStopError);
      expect(disposers[0]).toHaveBeenCalledOnce();
      expect(onTranscript).toHaveBeenCalledWith(
        expect.objectContaining({ text: "candidate adopted during cleanup" }),
      );
      expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ emitClosed: false });
      expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });
      expect(
        request.mock.calls.filter(
          ([method, params]) =>
            method === "talk.client.close" && params?.allocationId === "allocation-2",
        ),
      ).toHaveLength(1);

      await session.start();
      expect(createCount).toBe(3);
      session.stop();
    },
  );

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
      expect.objectContaining(closeRequestTimeoutOptions),
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
        expect.objectContaining(requestTimeoutOptions),
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
      expect.objectContaining(closeRequestTimeoutOptions),
    );

    session.stop();
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledOnce();
  });

  it.each([
    ["transport error", new Error("socket closed before acknowledgement")],
    [
      "gateway error",
      new GatewayRequestError({ code: "INVALID_REQUEST", message: "commit failed" }),
    ],
  ])("closes both possible owners after a sent %s", async (_label, commitError) => {
    let createCount = 0;
    const request = vi.fn(
      async (
        method: string,
        params?: { allocationId?: string },
        options?: { onSent?: () => void },
      ) => {
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
          options?.onSent?.();
          throw commitError;
        }
        return { state: "committed" };
      },
    );
    const onStatus = vi.fn();
    const session = new RealtimeTalkSession(
      { request, addEventListener: () => vi.fn() } as never,
      "agent:main:main",
      { onStatus },
    );
    await session.start();
    const activeStopError = new Error("active transport stop failed");
    transportMock.stop.mockImplementationOnce(() => {
      throw activeStopError;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(session.start()).rejects.toThrow(
      "Realtime Talk allocation commit could not be confirmed",
    );

    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "talk.client.commit" &&
          (params as { allocationId?: string })?.allocationId === "allocation-2",
      ),
    ).toHaveLength(1);
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
    expect(warn).toHaveBeenCalledWith(activeStopError);
    warn.mockRestore();
  });

  it.each([
    ["initial error", false, true, "error"],
    ["replacement error", true, false, "error"],
    ["replacement completed", true, true, "completed"],
  ])(
    "prefers an exact terminal during a sent %s commit rejection",
    async (_label, replacement, exhaustClose, outcome) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const disposers: Array<ReturnType<typeof vi.fn>> = [];
        const listeners: Array<(event: { event: string; payload?: unknown }) => void> = [];
        let closeAttempts = 0;
        let createCount = 0;
        const targetAllocation = replacement ? "allocation-2" : "allocation-1";
        const request = vi.fn(
          async (
            method: string,
            params?: { allocationId?: string },
            options?: { onSent?: () => void },
          ) => {
            if (method === "talk.client.create") {
              createCount += 1;
              return {
                provider: "openai",
                transport: "webrtc",
                voiceSessionId: "voice-exact-terminal",
                allocationId: `allocation-${createCount}`,
                clientSecret: "secret",
              };
            }
            if (method === "talk.client.commit" && params?.allocationId === targetAllocation) {
              options?.onSent?.();
              listeners[replacement ? 1 : 0]?.({
                event: "talk.client.allocation.terminal",
                payload: {
                  allocationId: targetAllocation,
                  outcome,
                  ...(outcome === "error" ? { message: "provider exact failure" } : {}),
                },
              });
              throw new Error("commit acknowledgement lost");
            }
            if (method === "talk.client.close" && params?.allocationId === targetAllocation) {
              closeAttempts += 1;
              if (exhaustClose) throw new Error("exact close unavailable");
            }
            return { state: "committed" };
          },
        );
        const onStatus = vi.fn((status: string) => {
          if (!replacement && status === "error") throw new Error("status observer failed");
        });
        const onTalkEvent = vi.fn<NonNullable<RealtimeTalkCallbacks["onTalkEvent"]>>(() => {
          if (!replacement) throw new Error("event observer failed");
        });
        const session = new RealtimeTalkSession(
          {
            request,
            addEventListener: (listener: (event: { event: string; payload?: unknown }) => void) => {
              listeners.push(listener);
              const dispose = vi.fn(() => {
                if (!replacement && disposers.length === 0) {
                  throw new Error("terminal disposer failed");
                }
              });
              disposers.push(dispose);
              return dispose;
            },
          } as never,
          "agent:main:main",
          { onStatus, onTalkEvent },
        );
        if (replacement) await session.start();
        if (!replacement) {
          transportMock.stop.mockImplementationOnce(() => {
            throw new Error("pending transport stop failed");
          });
        }
        onStatus.mockClear();

        const starting = session.start();
        if (exhaustClose) await vi.advanceTimersByTimeAsync(2_500);
        if (outcome === "error") await expect(starting).rejects.toThrow("provider exact failure");
        else await expect(starting).rejects.toThrow("commit acknowledgement lost");

        expect(closeAttempts).toBe(exhaustClose ? 3 : 1);
        expect(onStatus.mock.calls).toEqual([
          ...(!replacement ? [["connecting"]] : []),
          ...(outcome === "error" ? [["error", "provider exact failure"]] : []),
        ]);
        expect(onStatus).not.toHaveBeenCalledWith(
          "error",
          "Realtime Talk allocation commit could not be confirmed",
        );
        expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual(
          outcome === "error" ? ["session.error", "session.closed"] : [],
        );
        expect(disposers[replacement ? 1 : 0]).toHaveBeenCalledOnce();
        expect(
          [
            ...new Set(
              request.mock.calls
                .filter(([method]) => method === "talk.client.close")
                .map(([, params]) => (params as { allocationId?: string }).allocationId),
            ),
          ].toSorted((left, right) => String(left).localeCompare(String(right))),
        ).toEqual(replacement ? ["allocation-1", "allocation-2"] : [targetAllocation]);
        expect(transportMock.webRtcStops[replacement ? 1 : 0]).toHaveBeenCalledOnce();
        if (replacement) expect(transportMock.webRtcStops[0]).toHaveBeenCalledOnce();
        if (exhaustClose)
          expect(warn).toHaveBeenCalledWith(
            "Realtime Talk terminal cleanup failed",
            expect.any(Error),
          );

        await session.start();
        session.stop();
        await vi.runAllTimersAsync();
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("preserves the commit error when exact candidate close exhausts its retries", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let candidateCloseAttempts = 0;
      let createCount = 0;
      const request = vi.fn(
        async (
          method: string,
          params?: { allocationId?: string },
          options?: { onSent?: () => void },
        ) => {
          if (method === "talk.client.create") {
            createCount += 1;
            return {
              provider: "openai",
              transport: "webrtc",
              voiceSessionId: "voice-exhausted-close",
              allocationId: `allocation-${createCount}`,
              clientSecret: "secret",
            };
          }
          if (method === "talk.client.commit" && params?.allocationId === "allocation-2") {
            options?.onSent?.();
            throw new Error("commit acknowledgement lost");
          }
          if (method === "talk.client.close" && params?.allocationId === "allocation-2") {
            candidateCloseAttempts += 1;
            throw new Error("candidate close unavailable");
          }
          return { state: "committed" };
        },
      );
      const session = new RealtimeTalkSession(
        { request, addEventListener: () => vi.fn() } as never,
        "agent:main:main",
      );
      await session.start();

      const replacing = expect(session.start()).rejects.toThrow(
        "Realtime Talk allocation commit could not be confirmed",
      );
      await vi.advanceTimersByTimeAsync(2_500);
      await replacing;

      expect(candidateCloseAttempts).toBe(3);
      expect(warn).toHaveBeenCalledWith(
        "Realtime Talk candidate cleanup failed",
        expect.objectContaining({ message: "candidate close unavailable" }),
      );
      session.stop();
      await vi.runAllTimersAsync();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("preserves the commit error when buffered candidate cleanup reaches a throwing consumer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let createCount = 0;
      const disposers: Array<ReturnType<typeof vi.fn>> = [];
      const request = vi.fn(
        async (
          method: string,
          params?: { allocationId?: string },
          options?: { onSent?: () => void },
        ) => {
          if (method === "talk.client.create") {
            createCount += 1;
            return {
              provider: "openai",
              transport: "webrtc",
              voiceSessionId: "voice-buffered-cleanup",
              allocationId: `allocation-${createCount}`,
              clientSecret: "secret",
            };
          }
          if (method === "talk.client.commit" && params?.allocationId === "allocation-1") {
            options?.onSent?.();
            throw new Error("commit acknowledgement lost");
          }
          return { state: "committed" };
        },
      );
      const session = new RealtimeTalkSession(
        {
          request,
          addEventListener: () => {
            const dispose = vi.fn();
            disposers.push(dispose);
            return dispose;
          },
        } as never,
        "agent:main:main",
        {
          onTranscript: (entry) => {
            if (entry.text === "buffered consumer failure") {
              throw new Error("consumer failed during candidate cleanup");
            }
          },
        },
      );
      transportMock.start.mockImplementationOnce(async () => {
        transcriptContext(transportMock.webRtcContexts).callbacks.onTranscript?.({
          role: "user",
          text: "buffered consumer failure",
          final: true,
        });
        return "ready";
      });

      await expect(session.start()).rejects.toThrow(
        "Realtime Talk allocation commit could not be confirmed",
      );

      expect(disposers).toHaveLength(1);
      expect(disposers[0]).toHaveBeenCalledOnce();
      expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ emitClosed: false });
      expect(
        request.mock.calls.some(
          ([method, params]) =>
            method === "talk.client.abort" &&
            (params as { allocationId?: string })?.allocationId === "allocation-1",
        ),
      ).toBe(false);
      expect(
        request.mock.calls
          .filter(([method]) => method === "talk.client.close")
          .map(([, params]) => (params as { allocationId?: string }).allocationId)
          .toSorted((left, right) => String(left).localeCompare(String(right))),
      ).toEqual(["allocation-1"]);
      expect(warn).toHaveBeenCalledWith(
        "Realtime Talk candidate transcript callback failed",
        expect.objectContaining({ message: "consumer failed during candidate cleanup" }),
      );

      await expect(session.start()).resolves.toBeUndefined();
      expect(createCount).toBe(2);
      session.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not resurrect a committed candidate stopped by its adoption callback", async () => {
    const dispose = vi.fn();
    const request = vi.fn(async (method: string) =>
      method === "talk.client.create"
        ? {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-adopt-stop",
            allocationId: "allocation-adopt-stop",
            clientSecret: "secret",
          }
        : { state: "committed" },
    );
    let session!: RealtimeTalkSession;
    session = new RealtimeTalkSession(
      { request, addEventListener: () => dispose } as never,
      "agent:main:main",
      { onTranscript: () => session.stop() },
    );
    transportMock.start.mockImplementationOnce(async () => {
      transcriptContext(transportMock.webRtcContexts).callbacks.onTranscript?.({
        role: "user",
        text: "stop during adoption",
        final: true,
      });
      return "ready";
    });

    await session.start();

    expect(dispose).toHaveBeenCalledOnce();
    expect(transportMock.webRtcActivate).not.toHaveBeenCalled();
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "talk.client.close",
        {
          sessionKey: "agent:main:main",
          voiceSessionId: "voice-adopt-stop",
          allocationId: "allocation-adopt-stop",
        },
        expect.objectContaining(closeRequestTimeoutOptions),
      ),
    );
  });

  it("drains every buffered final before surfacing the first adoption callback failure", async () => {
    const persisted: string[] = [];
    const request = vi.fn(async (method: string, params?: { text?: string }) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-adopt-throw",
          allocationId: "allocation-adopt-throw",
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.transcript") {
        persisted.push(String(params?.text));
      }
      return { state: "committed" };
    });
    const delivered: string[] = [];
    const onTranscript = vi.fn((entry: { text: string }) => {
      delivered.push(entry.text);
      if (entry.text === "first buffered final") {
        throw new Error("consumer failed during adoption");
      }
    });
    const session = new RealtimeTalkSession(
      { request, addEventListener: () => vi.fn() } as never,
      "agent:main:main",
      { onTranscript },
    );
    transportMock.start.mockImplementationOnce(async () => {
      const callbacks = transcriptContext(transportMock.webRtcContexts).callbacks;
      callbacks.onTranscript?.({
        role: "user",
        text: "first buffered final",
        final: true,
      });
      callbacks.onTranscript?.({
        role: "assistant",
        text: "second buffered final",
        final: true,
      });
      return "ready";
    });

    await expect(session.start()).rejects.toThrow("consumer failed during adoption");

    expect(transportMock.webRtcActivate).not.toHaveBeenCalled();
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ emitClosed: false });
    expect(delivered).toEqual(["first buffered final", "second buffered final"]);
    expect(onTranscript).toHaveBeenCalledTimes(2);
    expect(persisted).toEqual(["first buffered final", "second buffered final"]);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "talk.client.close",
        {
          sessionKey: "agent:main:main",
          voiceSessionId: "voice-adopt-throw",
          allocationId: "allocation-adopt-throw",
        },
        expect.objectContaining(closeRequestTimeoutOptions),
      ),
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

  it("flushes a response-only terminal candidate before acknowledging close", async () => {
    const ready = createDeferred<"ready">();
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
        addEventListener: () => vi.fn(),
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
    ready.resolve("ready");
    await expect(starting).rejects.toThrow("provider startup failed");

    expect(requestOrder.indexOf("talk.client.transcript")).toBeLessThan(
      requestOrder.indexOf("talk.client.close"),
    );
  });

  it.each(["error", "completed"] as const)(
    "keeps the active call when a sent replacement commit returns an explicit %s terminal",
    async (outcome) => {
      const listeners: Array<(event: { event: string; payload?: unknown }) => void> = [];
      let createCount = 0;
      const request = vi.fn(
        async (
          method: string,
          params?: { allocationId?: string },
          options?: { onSent?: () => void },
        ) => {
          if (method === "talk.client.create") {
            createCount += 1;
            return {
              provider: "openai",
              transport: "webrtc",
              voiceSessionId: "voice-explicit-terminal",
              allocationId: `allocation-${createCount}`,
              clientSecret: "secret",
            };
          }
          if (method === "talk.client.commit" && params?.allocationId === "allocation-2") {
            options?.onSent?.();
            listeners[1]?.({
              event: "talk.client.allocation.terminal",
              payload: {
                allocationId: "allocation-2",
                outcome,
                ...(outcome === "error" ? { message: "replacement provider failed" } : {}),
              },
            });
            return {
              state: "terminal",
              terminal: {
                outcome,
                ...(outcome === "error" ? { message: "replacement provider failed" } : {}),
              },
            };
          }
          if (method === "talk.client.commit") return { state: "committed" };
          return { ok: true };
        },
      );
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
      onStatus.mockClear();

      const replacing = session.start();
      if (outcome === "error")
        await expect(replacing).rejects.toThrow("replacement provider failed");
      else await expect(replacing).resolves.toBeUndefined();

      expect(transportMock.webRtcStops[0]).not.toHaveBeenCalled();
      expect(transportMock.webRtcStops[1]).toHaveBeenCalledOnce();
      expect(transportMock.webRtcActivate).toHaveBeenCalledOnce();
      expect(
        request.mock.calls
          .filter(([method]) => method === "talk.client.close")
          .map(([, params]) => (params as { allocationId?: string }).allocationId),
      ).toEqual(["allocation-2"]);
      expect(onTalkEvent).not.toHaveBeenCalled();
      expect(onStatus).not.toHaveBeenCalled();
      session.stop();
    },
  );

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

    await expect(session.start()).rejects.toThrow("provider failed before transport startup");

    expect(transportMock.webRtcContexts).toHaveLength(1);
    expect(transportMock.webRtcStops[0]).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "talk.client.close",
      {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-create-terminal",
        allocationId: "allocation-2",
      },
      expect.objectContaining(closeRequestTimeoutOptions),
    );
    expect(onTalkEvent).not.toHaveBeenCalled();
    session.stop();
  });

  it("keeps active status and transport when a replacement is already completed", async () => {
    let createCount = 0;
    const onStatus = vi.fn();
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-completed-replacement",
          allocationId: `allocation-${createCount}`,
          clientSecret: "secret",
          ...(createCount === 2 ? { terminal: { outcome: "completed" } } : {}),
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
      { onStatus },
    );
    await session.start();
    onStatus.mockClear();

    await session.start();

    expect(onStatus).not.toHaveBeenCalled();
    expect(transportMock.webRtcStops[0]).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "talk.client.close",
      {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-completed-replacement",
        allocationId: "allocation-2",
      },
      expect.objectContaining(closeRequestTimeoutOptions),
    );
    session.stop();
  });

  it.each(["error", "completed"] as const)(
    "projects an active %s terminal once before blocked close and preserves a restart",
    async (outcome) => {
      const firstClose = createDeferred<void>();
      const listeners: Array<(event: { event: string; payload?: unknown }) => void> = [];
      let createCount = 0;
      let firstCloseFinished = false;
      const request = vi.fn(async (method: string, params?: { allocationId?: string }) => {
        if (method === "talk.client.create") {
          createCount += 1;
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-active-terminal",
            allocationId: `allocation-${createCount}`,
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.commit") return { state: "committed" };
        if (method === "talk.client.close" && params?.allocationId === "allocation-1") {
          await firstClose.promise;
          firstCloseFinished = true;
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
      onStatus.mockClear();
      onTalkEvent.mockClear();

      const terminalEvent = {
        event: "talk.client.allocation.terminal",
        payload: {
          sessionKey: "agent:main:main",
          voiceSessionId: "voice-active-terminal",
          allocationId: "allocation-1",
          outcome,
          ...(outcome === "error" ? { message: "active provider failed" } : {}),
        },
      };
      listeners[0]?.(terminalEvent);
      listeners[0]?.(terminalEvent);

      expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ emitClosed: false });
      expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual(
        outcome === "error" ? ["session.error", "session.closed"] : ["session.closed"],
      );
      expect(onStatus.mock.calls).toEqual([
        outcome === "error" ? ["error", "active provider failed"] : ["idle"],
      ]);
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "talk.client.close",
          {
            sessionKey: "agent:main:main",
            voiceSessionId: "voice-active-terminal",
            allocationId: "allocation-1",
          },
          expect.objectContaining(closeRequestTimeoutOptions),
        ),
      );

      transportMock.start.mockImplementationOnce(async () => {
        transcriptContext(transportMock.webRtcContexts, 1).callbacks.onStatus?.("listening");
        return "ready";
      });
      await session.start();
      expect(onStatus).toHaveBeenLastCalledWith("listening");

      firstClose.resolve();
      await vi.waitFor(() => expect(firstCloseFinished).toBe(true));
      expect(onStatus).toHaveBeenLastCalledWith("listening");
      session.stop();
    },
  );

  it.each(["error", "completed"] as const)(
    "retires both calls when a committed replacement emits a %s terminal event",
    async (outcome) => {
      const activeClose = createDeferred<void>();
      const replacementCommit = createDeferred<{ state: "committed" }>();
      const listeners: Array<(event: { event: string; payload?: unknown }) => void> = [];
      let createCount = 0;
      const request = vi.fn(
        async (
          method: string,
          params?: { allocationId?: string },
          options?: { onSent?: () => void },
        ) => {
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
            options?.onSent?.();
            return await replacementCommit.promise;
          }
          if (method === "talk.client.commit") return { state: "committed" };
          if (
            outcome === "completed" &&
            method === "talk.client.close" &&
            params?.allocationId === "allocation-1"
          ) {
            await activeClose.promise;
          }
          return { ok: true };
        },
      );
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
      onStatus.mockClear();

      const replacing = session.start();
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "talk.client.commit",
          {
            sessionKey: "agent:main:main",
            voiceSessionId: "voice-terminal-adoption",
            allocationId: "allocation-2",
          },
          expect.objectContaining(requestTimeoutOptions),
        ),
      );
      listeners[1]?.({
        event: "talk.client.allocation.terminal",
        payload: {
          sessionKey: "agent:main:main",
          voiceSessionId: "voice-terminal-adoption",
          allocationId: "allocation-2",
          outcome,
          ...(outcome === "error" ? { message: "sideband failed during commit" } : {}),
        },
      });
      expect(onTalkEvent).not.toHaveBeenCalled();

      replacementCommit.resolve({ state: "committed" });
      if (outcome === "error") {
        await expect(replacing).rejects.toThrow("sideband failed during commit");
      } else {
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith(
            "talk.client.close",
            expect.objectContaining({ allocationId: "allocation-1" }),
            expect.anything(),
          ),
        );
        expect(onTalkEvent).not.toHaveBeenCalled();
        expect(onStatus).not.toHaveBeenCalled();
        activeClose.resolve();
        await expect(replacing).resolves.toBeUndefined();
      }

      expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual(
        outcome === "error" ? ["session.error", "session.closed"] : ["session.closed"],
      );
      expect(onStatus.mock.calls).toEqual([
        outcome === "error" ? ["error", "sideband failed during commit"] : ["idle"],
      ]);
      expect(transportMock.webRtcActivate).toHaveBeenCalledOnce();
      expect(transportMock.webRtcStops[0]).toHaveBeenCalledOnce();
      expect(transportMock.webRtcStops[1]).toHaveBeenCalledOnce();
      expect(
        request.mock.calls
          .filter(([method]) => method === "talk.client.close")
          .map(([, params]) => (params as { allocationId?: string }).allocationId)
          .toSorted((left, right) => String(left).localeCompare(String(right))),
      ).toEqual(["allocation-1", "allocation-2"]);
    },
  );

  it("surfaces stale allocation close exhaustion and releases its owner", async () => {
    vi.useFakeTimers();
    try {
      const created = createDeferred<{
        provider: string;
        transport: string;
        voiceSessionId: string;
        allocationId: string;
        clientSecret: string;
      }>();
      let createCount = 0;
      let closeAttempts = 0;
      const request = vi.fn(async (method: string, params?: { allocationId?: string }) => {
        if (method === "talk.client.create") {
          createCount += 1;
          if (createCount === 1) return await created.promise;
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-stale-recovered",
            allocationId: "allocation-2",
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.abort") return { state: "terminal" };
        if (method === "talk.client.close" && params?.allocationId === "allocation-1") {
          closeAttempts += 1;
          throw new Error("stale close unavailable");
        }
        return { state: "committed" };
      });
      const session = new RealtimeTalkSession(
        { request, addEventListener: () => vi.fn() } as never,
        "agent:main:main",
      );

      const starting = session.start();
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "talk.client.create",
          expect.anything(),
          expect.anything(),
        ),
      );
      session.stop();
      created.resolve({
        provider: "openai",
        transport: "webrtc",
        voiceSessionId: "voice-stale",
        allocationId: "allocation-1",
        clientSecret: "secret",
      });
      const failed = expect(starting).rejects.toThrow("stale close unavailable");
      await vi.advanceTimersByTimeAsync(2_500);
      await failed;

      expect(closeAttempts).toBe(3);
      await expect(session.start()).resolves.toBeUndefined();
      session.stop();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves replacement mismatch when exact cleanup exhausts", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let createCount = 0;
      let closeAttempts = 0;
      const closeError = new Error("mismatched close unavailable");
      const request = vi.fn(async (method: string, params?: { allocationId?: string }) => {
        if (method === "talk.client.create") {
          createCount += 1;
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: `voice-mismatch-${createCount}`,
            allocationId: `allocation-${createCount}`,
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.abort" && params?.allocationId === "allocation-2") {
          return { state: "terminal" };
        }
        if (method === "talk.client.close" && params?.allocationId === "allocation-2") {
          closeAttempts += 1;
          throw closeError;
        }
        return { state: "committed" };
      });
      const session = new RealtimeTalkSession(
        { request, addEventListener: () => vi.fn() } as never,
        "agent:main:main",
      );
      await session.start();

      const replacing = expect(session.start()).rejects.toMatchObject({
        message: "Realtime Talk replacement changed the active voice session",
        cause: closeError,
      });
      await vi.advanceTimersByTimeAsync(2_500);
      await replacing;

      expect(closeAttempts).toBe(3);
      expect(warn).toHaveBeenCalledWith("Realtime Talk allocation abort failed", closeError);
      expect(transportMock.webRtcStops[0]).not.toHaveBeenCalled();
      session.stop();
      await vi.runAllTimersAsync();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
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
      expect.objectContaining(closeRequestTimeoutOptions),
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
      expect.objectContaining(closeRequestTimeoutOptions),
    );
  });
});
