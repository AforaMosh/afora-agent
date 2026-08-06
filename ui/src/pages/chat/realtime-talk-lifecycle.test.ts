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

  it("retries finalized transcript writes in order", async () => {
    vi.useFakeTimers();
    try {
      const transcriptEntryIds: string[] = [];
      let firstAttempt = true;
      const request = vi.fn(async (method: string, params?: { entryId?: string }) => {
        if (method === "talk.client.create") {
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-queue",
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.transcript") {
          transcriptEntryIds.push(String(params?.entryId));
          if (params?.entryId === "1" && firstAttempt) {
            firstAttempt = false;
            throw new Error("temporary failure");
          }
          return { ok: true };
        }
        return { ok: true };
      });
      const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
      await session.start();
      const context = transcriptContext(transportMock.webRtcContexts);
      context.callbacks.onTranscript?.({ role: "user", text: "first", final: true });
      context.callbacks.onTranscript?.({ role: "assistant", text: "second", final: true });

      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(transcriptEntryIds).toEqual(["1", "1", "2"]));
      session.stop();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues entry ids when the same voice session replaces its transport", async () => {
    const transcriptEntryIds: string[] = [];
    const request = vi.fn(async (method: string, params?: { entryId?: string }) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-resume",
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.transcript") {
        transcriptEntryIds.push(String(params?.entryId));
      }
      return { ok: true };
    });
    const client = { request } as never;
    const session = new RealtimeTalkSession(client, "agent:main:main", {});

    await session.start();
    const firstContext = transcriptContext(transportMock.webRtcContexts);
    firstContext.callbacks.onTranscript?.({ role: "user", text: "first", final: true });
    await firstContext.flushTranscriptWrites?.();

    await session.start();
    const secondContext = transcriptContext(transportMock.webRtcContexts, 1);
    secondContext.callbacks.onTranscript?.({ role: "assistant", text: "second", final: true });
    await secondContext.flushTranscriptWrites?.();

    expect(transcriptEntryIds).toEqual(["1", "2"]);
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledOnce();
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ emitClosed: false });
    expect(transportMock.webRtcStops[1]).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([method]) => method === "talk.client.create")).toEqual([
      [
        "talk.client.create",
        { sessionKey: "agent:main:main", capabilities: ["voice-transcript"] },
        requestTimeoutOptions,
      ],
      [
        "talk.client.create",
        {
          sessionKey: "agent:main:main",
          voiceSessionId: "voice-resume",
          capabilities: ["voice-transcript"],
        },
        requestTimeoutOptions,
      ],
    ]);
    session.stop();
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledOnce();
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith();
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(
        1,
      ),
    );
    await Promise.resolve();

    const firstReplacement = new RealtimeTalkSession(client, "agent:main:main");
    const secondReplacement = new RealtimeTalkSession(client, "agent:main:main");
    await firstReplacement.start();
    await secondReplacement.start();
    firstReplacement.stop();
    secondReplacement.stop();
  });

  it("restores the existing owner when same-session transport startup fails", async () => {
    const transcriptEntryIds: string[] = [];
    const request = vi.fn(async (method: string, params?: { entryId?: string }) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-existing",
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
    transportMock.start.mockRejectedValueOnce(new Error("replacement startup failed"));

    await expect(session.start()).rejects.toThrow("replacement startup failed");
    expect(request.mock.calls.some(([method]) => method === "talk.client.close")).toBe(false);
    expect(transportMock.webRtcStops[0]).not.toHaveBeenCalled();
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledOnce();
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });

    existingContext.callbacks.onTranscript?.({ role: "user", text: "still active", final: true });
    await existingContext.flushTranscriptWrites?.();
    expect(transcriptEntryIds).toEqual(["1"]);

    const concurrent = new RealtimeTalkSession(client, "agent:main:main");
    await concurrent.start();
    concurrent.stop();
    session.stop();
  });

  it("keeps the active transport when a replacement cancels during startup", async () => {
    const transcriptEntryIds: string[] = [];
    const request = vi.fn(async (method: string, params?: { entryId?: string }) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-cancelled-replacement",
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.transcript") {
        transcriptEntryIds.push(String(params?.entryId));
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();
    const activeContext = transcriptContext(transportMock.webRtcContexts);
    transportMock.start.mockResolvedValueOnce("cancelled");

    await session.start();

    expect(transportMock.webRtcStops[0]).not.toHaveBeenCalled();
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });
    expect(request.mock.calls.some(([method]) => method === "talk.client.close")).toBe(false);
    activeContext.callbacks.onTranscript?.({
      role: "user",
      text: "active transport survived",
      final: true,
    });
    await activeContext.flushTranscriptWrites?.();
    expect(transcriptEntryIds).toEqual(["1"]);
    session.stop();
  });

  it("surfaces direct candidate close exhaustion after startup cancellation", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let closeAttempts = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.create") {
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-cancelled-initial",
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.close") {
          closeAttempts += 1;
          throw new Error("direct close unavailable");
        }
        return { ok: true };
      });
      const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
      transportMock.start.mockResolvedValueOnce("cancelled");

      const starting = expect(session.start()).rejects.toThrow("direct close unavailable");
      await vi.advanceTimersByTimeAsync(2_500);
      await starting;

      expect(closeAttempts).toBe(3);
      expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ emitClosed: false });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retires the active relay before replacement activation", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "gateway-relay",
          relaySessionId: "relay-activation",
          audio: {
            inputEncoding: "pcm16",
            inputSampleRateHz: 24_000,
            outputEncoding: "pcm16",
            outputSampleRateHz: 24_000,
          },
        };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();
    transportMock.relayActivate.mockImplementationOnce(() => {
      throw new Error("activation failed");
    });

    await expect(session.start()).rejects.toThrow("activation failed");

    expect(transportMock.relayStops[0]).toHaveBeenCalledWith({ emitClosed: false });
    expect(transportMock.relayStops[1]).toHaveBeenCalledWith({ emitClosed: false });
    session.stop();
    expect(transportMock.relayStops[0]).toHaveBeenCalledOnce();
  });

  it("does not restore an active relay after activation stops the session", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "gateway-relay",
          relaySessionId: "relay-activation-stop",
          audio: {
            inputEncoding: "pcm16",
            inputSampleRateHz: 24_000,
            outputEncoding: "pcm16",
            outputSampleRateHz: 24_000,
          },
        };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();
    transportMock.relayActivate.mockImplementationOnce(() => {
      session.stop();
      throw new Error("activation stopped");
    });

    await expect(session.start()).rejects.toThrow("activation stopped");

    expect(transportMock.relayStops[0]).toHaveBeenCalledOnce();
    expect(transportMock.relayStops[0]).toHaveBeenCalledWith({ emitClosed: false });
    expect(transportMock.relayStops[1]).toHaveBeenCalledOnce();
    session.stop();
    expect(transportMock.relayStops[0]).toHaveBeenCalledOnce();
    expect(transportMock.relayStops[1]).toHaveBeenCalledOnce();
  });

  it("serializes overlapping replacements and aborts a superseded candidate", async () => {
    const firstReplacementStart = createDeferred<"ready">();
    let createCount = 0;
    const transcriptEntryIds: string[] = [];
    const request = vi.fn(
      async (method: string, params?: { allocationId?: string; entryId?: string }) => {
        if (method === "talk.client.create") {
          createCount += 1;
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-overlapping-replacements",
            allocationId: `allocation-${createCount}`,
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.transcript") {
          transcriptEntryIds.push(String(params?.entryId));
        }
        if (method === "talk.client.commit") {
          return { state: "committed" };
        }
        if (method === "talk.client.abort") {
          return { state: "aborted" };
        }
        return { ok: true };
      },
    );
    const session = new RealtimeTalkSession(
      { request, addEventListener: () => vi.fn() } as never,
      "agent:main:main",
    );
    await session.start();
    transportMock.start.mockImplementationOnce(async () => await firstReplacementStart.promise);

    const firstReplacement = session.start();
    await vi.waitFor(() => expect(transportMock.webRtcContexts).toHaveLength(2));
    const secondReplacement = session.start();
    await Promise.resolve();
    expect(transportMock.webRtcContexts).toHaveLength(2);

    firstReplacementStart.resolve("ready");
    await firstReplacement;
    await secondReplacement;
    const supersededContext = transcriptContext(transportMock.webRtcContexts, 1);
    const activeContext = transcriptContext(transportMock.webRtcContexts, 2);
    supersededContext.callbacks.onTranscript?.({ role: "user", text: "stale", final: true });
    activeContext.callbacks.onTranscript?.({ role: "user", text: "active", final: true });
    await activeContext.flushTranscriptWrites?.();
    expect(transcriptEntryIds).toEqual(["1"]);
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });
    expect(request).toHaveBeenCalledWith(
      "talk.client.abort",
      {
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-overlapping-replacements",
        allocationId: "allocation-2",
      },
      requestTimeoutOptions,
    );

    session.stop();
  });

  it("waits for an exact candidate close retry before starting the queued replacement", async () => {
    vi.useFakeTimers();
    try {
      const replacementCommit = createDeferred<{ state: "committed" }>();
      let candidateCloseAttempts = 0;
      let createCount = 0;
      const requestOrder: string[] = [];
      const request = vi.fn(
        async (
          method: string,
          params?: { allocationId?: string },
          options?: { timeoutMs?: number },
        ) => {
          requestOrder.push(`${method}:${params?.allocationId ?? ""}`);
          if (method === "talk.client.create") {
            createCount += 1;
            return {
              provider: "openai",
              transport: "webrtc",
              voiceSessionId: "voice-commit-fence",
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
          if (method === "talk.client.close" && params?.allocationId === "allocation-2") {
            candidateCloseAttempts += 1;
            if (candidateCloseAttempts === 1) {
              return await new Promise((_, reject) => {
                setTimeout(
                  () => reject(new Error("candidate close timed out")),
                  options?.timeoutMs,
                );
              });
            }
          }
          return { ok: true };
        },
      );
      const session = new RealtimeTalkSession(
        { request, addEventListener: () => vi.fn() } as never,
        "agent:main:main",
      );
      await session.start();

      const firstReplacement = session.start();
      await vi.waitFor(() => expect(requestOrder).toContain("talk.client.commit:allocation-2"));
      const secondReplacement = session.start();
      await Promise.resolve();
      expect(createCount).toBe(2);

      replacementCommit.resolve({ state: "committed" });
      await vi.advanceTimersByTimeAsync(9_165);
      expect(createCount).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(createCount).toBe(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(createCount).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      await firstReplacement;
      await secondReplacement;

      const candidateCloses = request.mock.calls.filter(
        ([method, params]) =>
          method === "talk.client.close" &&
          (params as { allocationId?: string })?.allocationId === "allocation-2",
      );
      expect(candidateCloses).toHaveLength(2);
      expect(
        candidateCloses.map(([, params]) => (params as { allocationId?: string }).allocationId),
      ).toEqual(["allocation-2", "allocation-2"]);
      expect(candidateCloses.map(([, , options]) => options)).toEqual([
        expect.objectContaining({ timeoutMs: 9_166 }),
        expect.objectContaining({ timeoutMs: 9_166 }),
      ]);
      expect(createCount).toBe(3);
      expect(requestOrder.lastIndexOf("talk.client.close:allocation-2")).toBeLessThan(
        requestOrder.lastIndexOf("talk.client.create:"),
      );
      expect(
        request.mock.calls.some(
          ([method, params]) =>
            method === "talk.client.close" &&
            (params as { allocationId?: string })?.allocationId === "allocation-1",
        ),
      ).toBe(false);
      session.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a pending replacement when transcript overflow closes the active call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const replacementStart = createDeferred<"ready">();
    const firstTranscript = createDeferred<void>();
    const request = vi.fn(async (method: string, params?: { entryId?: string }) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-overflow-replacement",
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.transcript" && params?.entryId === "1") {
        await firstTranscript.promise;
      }
      return { ok: true };
    });
    const onStatus = vi.fn((status: string) => {
      if (status === "error") throw new Error("status observer failed");
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main", {
      onStatus,
    });
    await session.start();
    const activeContext = transcriptContext(transportMock.webRtcContexts);
    transportMock.start.mockImplementationOnce(async () => await replacementStart.promise);

    const replacement = session.start();
    await vi.waitFor(() => expect(transportMock.webRtcContexts).toHaveLength(2));
    expect(() => {
      for (let index = 0; index < 42; index += 1) {
        activeContext.callbacks.onTranscript?.({
          role: "user",
          text: "x".repeat(9_000),
          final: true,
        });
      }
    }).not.toThrow();

    expect(onStatus).toHaveBeenCalledWith("error", expect.stringContaining("could not keep up"));
    expect(warn).toHaveBeenCalledWith("Realtime Talk observer failed");
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith();
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });

    replacementStart.resolve("ready");
    await replacement;
    firstTranscript.resolve();
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([method]) => method === "talk.client.close")).toBe(true),
    );
    warn.mockRestore();
  });

  it("preserves candidate overflow when its status observer throws", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-candidate-overflow",
          allocationId: "allocation-candidate-overflow",
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.abort") return { state: "aborted" };
      return { state: "committed" };
    });
    const onStatus = vi.fn((status: string) => {
      if (status === "error") throw new Error("status observer failed");
    });
    const session = new RealtimeTalkSession(
      { request, addEventListener: () => vi.fn() } as never,
      "agent:main:main",
      { onStatus },
    );
    transportMock.start.mockImplementationOnce(async () => {
      const context = transcriptContext(transportMock.webRtcContexts);
      for (let index = 0; index < 42; index += 1) {
        context.callbacks.onTranscript?.({
          role: "user",
          text: "x".repeat(9_000),
          final: true,
        });
      }
      return "ready";
    });

    await expect(session.start()).rejects.toThrow("Voice transcript persistence could not keep up");
    expect(onStatus).toHaveBeenCalledWith("error", expect.stringContaining("could not keep up"));
    await expect(session.start()).resolves.toBeUndefined();
    session.stop();
  });

  it("surfaces transcript failure after three attempts", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.create") {
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-failure",
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.transcript") {
          throw new Error("still unavailable");
        }
        return { ok: true };
      });
      const onStatus = vi.fn((status: string) => {
        if (status === "error") throw new Error("status observer failed");
      });
      const session = new RealtimeTalkSession({ request } as never, "agent:main:main", {
        onStatus,
      });
      await session.start();
      const context = transcriptContext(transportMock.webRtcContexts);
      context.callbacks.onTranscript?.({ role: "user", text: "save me", final: true });

      await vi.advanceTimersByTimeAsync(2_500);
      await vi.waitFor(() =>
        expect(onStatus).toHaveBeenCalledWith(
          "error",
          expect.stringContaining("Voice transcript could not be saved"),
        ),
      );
      expect(
        request.mock.calls.filter(([method]) => method === "talk.client.transcript"),
      ).toHaveLength(3);
      expect(warn).toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
      session.stop();
      await vi.runAllTimersAsync();
    } finally {
      process.off("unhandledRejection", unhandled);
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries logical voice-session close after transient failures", async () => {
    vi.useFakeTimers();
    try {
      let closeAttempts = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.create") {
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-close-retry",
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.close" && ++closeAttempts < 3) {
          throw new Error("temporary close failure");
        }
        return { ok: true };
      });
      const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
      await session.start();

      session.stop();
      await vi.runAllTimersAsync();

      expect(closeAttempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses an old close failure after an immediate restart", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let createCount = 0;
      let firstCloseAttempts = 0;
      const request = vi.fn(async (method: string, params?: { voiceSessionId?: string }) => {
        if (method === "talk.client.create") {
          createCount += 1;
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: `voice-restart-${createCount}`,
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.close" && params?.voiceSessionId === "voice-restart-1") {
          firstCloseAttempts += 1;
          throw new Error("old close failed");
        }
        return { ok: true };
      });
      const onStatus = vi.fn();
      const session = new RealtimeTalkSession({ request } as never, "agent:main:main", {
        onStatus,
      });
      await session.start();

      session.stop();
      await session.start();
      await vi.advanceTimersByTimeAsync(2_500);

      expect(firstCloseAttempts).toBe(3);
      expect(onStatus).not.toHaveBeenCalledWith(
        "error",
        "Realtime Talk voice session close failed",
      );
      session.stop();
      await vi.runAllTimersAsync();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("reports an exhausted close failure when shutdown is not superseded", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let closeAttempts = 0;
      const closeError = new Error("close unavailable");
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.create") {
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-close-failure",
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.close") {
          closeAttempts += 1;
          throw closeError;
        }
        return { ok: true };
      });
      const onStatus = vi.fn((status: string) => {
        if (status === "error") throw new Error("status observer failed");
      });
      const session = new RealtimeTalkSession({ request } as never, "agent:main:main", {
        onStatus,
      });
      await session.start();

      session.stop();
      await vi.advanceTimersByTimeAsync(2_500);

      expect(closeAttempts).toBe(3);
      expect(onStatus).toHaveBeenCalledWith("error", "Realtime Talk voice session close failed");
      expect(warn).toHaveBeenCalledWith(closeError);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("starts a new call without resuming the voice session being closed", async () => {
    let createCount = 0;
    let finishClose: (() => void) | undefined;
    const closing = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-${createCount}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.close") {
        await closing;
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();

    session.stop();
    await session.start();

    const creates = request.mock.calls.filter(([method]) => method === "talk.client.create");
    expect(creates).toEqual([
      [
        "talk.client.create",
        { sessionKey: "agent:main:main", capabilities: ["voice-transcript"] },
        requestTimeoutOptions,
      ],
      [
        "talk.client.create",
        { sessionKey: "agent:main:main", capabilities: ["voice-transcript"] },
        requestTimeoutOptions,
      ],
    ]);
    finishClose?.();
    await Promise.resolve();
  });

  it("bounds active and draining client voice owners across session objects", async () => {
    let createCount = 0;
    const closes: Array<ReturnType<typeof createDeferred<void>>> = [];
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-${createCount}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.close") {
        const close = createDeferred<void>();
        closes.push(close);
        await close.promise;
      }
      return { ok: true };
    });
    const client = { request } as never;
    const first = new RealtimeTalkSession(client, "agent:main:main");
    const second = new RealtimeTalkSession(client, "agent:main:main");
    const third = new RealtimeTalkSession(client, "agent:main:main");

    await first.start();
    first.stop();
    await vi.waitFor(() => expect(closes).toHaveLength(1));
    await second.start();
    second.stop();
    await vi.waitFor(() => expect(closes).toHaveLength(2));

    await expect(third.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );
    expect(createCount).toBe(2);

    closes[0]?.resolve();
    await vi.waitFor(async () => {
      await third.start();
      expect(createCount).toBe(3);
    });

    third.stop();
    await vi.waitFor(() => expect(closes).toHaveLength(3));
    closes[1]?.resolve();
    closes[2]?.resolve();
  });

  it("bounds stalled detached owners across browser session keys", async () => {
    vi.useFakeTimers();
    try {
      let createCount = 0;
      const closeSignals: AbortSignal[] = [];
      const request = vi.fn(
        async (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
          if (method === "talk.client.create") {
            createCount += 1;
            return {
              provider: "openai",
              transport: "webrtc",
              voiceSessionId: `voice-${createCount}`,
              clientSecret: "secret",
            };
          }
          if (method === "talk.client.close") {
            const signal = options?.signal;
            if (!signal) {
              throw new Error("expected close abort signal");
            }
            closeSignals.push(signal);
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          }
          return { ok: true };
        },
      );
      const client = { request } as never;
      const draining = Array.from(
        { length: 16 },
        (_, index) => new RealtimeTalkSession(client, `agent:main:session-${index}`),
      );

      for (const session of draining) {
        await session.start();
        session.stop();
        await Promise.resolve();
      }
      expect(closeSignals).toHaveLength(16);

      const recovered = new RealtimeTalkSession(client, "agent:main:session-recovered");
      await expect(recovered.start()).rejects.toThrow(
        "Too many active or closing realtime Talk voice sessions",
      );
      expect(createCount).toBe(16);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(closeSignals.every((signal) => !signal.aborted)).toBe(true);
      await expect(recovered.start()).rejects.toThrow(
        "Too many active or closing realtime Talk voice sessions",
      );

      await vi.advanceTimersByTimeAsync(14_999);
      expect(closeSignals.every((signal) => !signal.aborted)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(closeSignals.every((signal) => signal.aborted)).toBe(true);

      await recovered.start();
      expect(createCount).toBe(17);
      recovered.stop();
      await vi.advanceTimersByTimeAsync(45_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases bounded startup owners after request deadlines", async () => {
    vi.useFakeTimers();
    let failCreate = true;
    try {
      const request = vi.fn(
        async (method: string, _params?: unknown, options?: { timeoutMs?: number }) => {
          if (method !== "talk.client.create") {
            return { ok: true };
          }
          if (!failCreate) {
            return {
              provider: "openai",
              transport: "webrtc",
              voiceSessionId: "voice-recovered",
              clientSecret: "secret",
            };
          }
          await new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error("request timeout")), options?.timeoutMs);
          });
          return { ok: true };
        },
      );
      const client = { request } as never;
      const first = new RealtimeTalkSession(client, "agent:main:main", {}, { transport: "webrtc" });
      const second = new RealtimeTalkSession(
        client,
        "agent:main:main",
        {},
        { transport: "webrtc" },
      );
      const third = new RealtimeTalkSession(client, "agent:main:main", {}, { transport: "webrtc" });

      const startsSettled = Promise.allSettled([first.start(), second.start()]);
      await Promise.resolve();
      await Promise.resolve();
      await expect(third.start()).rejects.toThrow(
        "Too many active or closing realtime Talk voice sessions",
      );
      expect(request.mock.calls.filter(([method]) => method === "talk.client.create")).toHaveLength(
        2,
      );

      await vi.advanceTimersByTimeAsync(30_000);
      const settled = await startsSettled;
      expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);

      failCreate = false;
      await third.start();
      third.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores final transcript callbacks emitted after shutdown begins", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-shutdown",
          clientSecret: "secret",
        };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();
    const context = transcriptContext(transportMock.webRtcContexts);

    session.stop();
    context.callbacks.onTranscript?.({ role: "user", text: "too late", final: true });
    await Promise.resolve();

    expect(request.mock.calls.some(([method]) => method === "talk.client.transcript")).toBe(false);
  });

  it("drops a previous transport's delayed transcript after stop and restart", async () => {
    let createCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-${createCount}`,
          clientSecret: "secret",
        };
      }
      return { ok: true };
    });
    const onTranscript = vi.fn();
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main", {
      onTranscript,
    });
    await session.start();
    const previousContext = transcriptContext(transportMock.webRtcContexts);

    session.stop();
    await session.start();
    previousContext.callbacks.onTranscript?.({
      role: "user",
      text: "stale transcript",
      final: true,
    });
    await Promise.resolve();

    expect(onTranscript).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([method]) => method === "talk.client.transcript")).toBe(false);
  });

  it("does not report Gateway relay transcripts through the client RPC", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "gateway-relay",
          relaySessionId: "relay-voice",
          audio: {
            inputEncoding: "pcm16",
            inputSampleRateHz: 24_000,
            outputEncoding: "pcm16",
            outputSampleRateHz: 24_000,
          },
        };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();
    const context = transcriptContext(transportMock.relayContexts);
    expect(transportMock.relayActivate).toHaveBeenCalledOnce();
    context.callbacks.onTranscript?.({ role: "user", text: "server owns this", final: true });
    await Promise.resolve();

    expect(request.mock.calls.some(([method]) => method === "talk.client.transcript")).toBe(false);
    session.stop();
    await Promise.resolve();
    expect(request.mock.calls.some(([method]) => method === "talk.client.close")).toBe(false);
  });
});
