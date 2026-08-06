import { describe, expect, it, vi } from "vitest";
import {
  acquireTalkConnectionLease,
  cleanupTalkConnection,
  registerTalkConnectionCleanup,
} from "./talk-session-registry.js";

describe("Talk connection cleanup registry", () => {
  it("runs replacement and late owners in the same disconnect drain", async () => {
    const events: string[] = [];
    const replacedRealtimeCleanup = vi.fn();
    const lateRealtimeCleanup = vi.fn(() => {
      events.push("late-realtime");
    });
    const log = { warn: vi.fn() };

    registerTalkConnectionCleanup("conn-reentry", "realtime-relay", replacedRealtimeCleanup);
    registerTalkConnectionCleanup("conn-reentry", "realtime-relay", () => {
      events.push("realtime");
      registerTalkConnectionCleanup("conn-reentry", "realtime-relay", lateRealtimeCleanup);
      void cleanupTalkConnection("conn-reentry", log);
    });
    registerTalkConnectionCleanup("conn-reentry", "transcription-relay", () => {
      events.push("transcription");
    });

    await cleanupTalkConnection("conn-reentry", log);
    expect(events).toEqual(["realtime", "transcription", "late-realtime"]);
    expect(replacedRealtimeCleanup).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("waits for startup leases and drains relay owners registered after close starts", async () => {
    const lease = acquireTalkConnectionLease("conn-late-relays");
    const realtimeCleanup = vi.fn();
    const transcriptionCleanup = vi.fn();
    const log = { warn: vi.fn() };

    const drain = cleanupTalkConnection("conn-late-relays", log);
    registerTalkConnectionCleanup("conn-late-relays", "realtime-relay", realtimeCleanup);
    registerTalkConnectionCleanup("conn-late-relays", "transcription-relay", transcriptionCleanup);

    expect(() => lease.assertActive()).toThrow("connection closed during startup");
    expect(() => acquireTalkConnectionLease("conn-late-relays")).toThrow(
      "connection closed during startup",
    );
    lease.release();
    await drain;

    expect(realtimeCleanup).toHaveBeenCalledOnce();
    expect(transcriptionCleanup).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("shares one pending drain across concurrent callers", async () => {
    let finishCleanup!: () => void;
    const pendingCleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const cleanup = vi.fn(() => pendingCleanup);
    const log = { warn: vi.fn() };
    registerTalkConnectionCleanup("conn-concurrent", "browser-allocation", cleanup);

    const firstDrain = cleanupTalkConnection("conn-concurrent", log);
    const secondDrain = cleanupTalkConnection("conn-concurrent", log);

    expect(secondDrain).toBe(firstDrain);
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledOnce();
    finishCleanup();
    await Promise.all([firstDrain, secondDrain]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs a synchronous failure and continues later owners", async () => {
    const transcriptionCleanup = vi.fn();
    const log = { warn: vi.fn() };

    registerTalkConnectionCleanup("conn-sync-error", "realtime-relay", () => {
      throw new Error("realtime cleanup failed");
    });
    registerTalkConnectionCleanup("conn-sync-error", "transcription-relay", transcriptionCleanup);

    await cleanupTalkConnection("conn-sync-error", log);

    expect(log.warn).toHaveBeenCalledWith(
      "failed to run realtime-relay Talk cleanup after connection disconnect: realtime cleanup failed",
    );
    expect(transcriptionCleanup).toHaveBeenCalledOnce();
  });

  it("logs an asynchronous failure and resolves the shared drain", async () => {
    const realtimeCleanup = vi.fn();
    const log = { warn: vi.fn() };

    registerTalkConnectionCleanup("conn-async-error", "browser-allocation", async () => {
      throw new Error("browser cleanup failed");
    });
    registerTalkConnectionCleanup("conn-async-error", "realtime-relay", realtimeCleanup);

    await expect(cleanupTalkConnection("conn-async-error", log)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      "failed to run browser-allocation Talk cleanup after connection disconnect: browser cleanup failed",
    );
    expect(realtimeCleanup).toHaveBeenCalledOnce();
  });
});
