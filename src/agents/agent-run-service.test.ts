import { describe, expect, it, vi } from "vitest";
import type { AgentRunResult } from "./agent-run-service-contract.js";
import { AgentRunService } from "./agent-run-service.js";
import type { AgentCommandIngressOpts } from "./command/types.js";
import { isAgentRunDirectAbortReason } from "./run-termination.js";

const runResult = {
  payloads: [],
  meta: { durationMs: 0 },
} satisfies AgentRunResult;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createStartInput(runId = "run-1") {
  return {
    runId,
    sessionKey: "agent:main:main",
    message: "hello",
    allowModelOverride: false,
  };
}

describe("AgentRunService", () => {
  it("starts the canonical ingress command with runtime-owned identity", async () => {
    const execute = vi.fn(async (_input: AgentCommandIngressOpts) => runResult);
    const service = new AgentRunService(execute);

    const handle = service.start(createStartInput());
    await handle.result;

    expect(handle.runId).toBe("run-1");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        sessionKey: "agent:main:main",
        message: "hello",
        allowModelOverride: false,
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty("to");
  });

  it("strips a runtime-supplied routing target", async () => {
    const execute = vi.fn(async (_input: AgentCommandIngressOpts) => runResult);
    const service = new AgentRunService(execute);
    const input = { ...createStartInput(), to: "unexpected-target" };

    await service.start(input).result;

    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty("to");
  });

  it("cancels an active run with the canonical direct-abort reason", async () => {
    const deferred = createDeferred<AgentRunResult>();
    let signal: AbortSignal | undefined;
    const service = new AgentRunService(async (input) => {
      signal = input.abortSignal;
      return await deferred.promise;
    });
    const handle = service.start(createStartInput());
    await vi.waitFor(() => expect(signal).toBeDefined());

    expect(handle.cancel()).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(isAgentRunDirectAbortReason(signal?.reason)).toBe(true);
    expect(handle.cancel()).toBe(false);

    deferred.resolve(runResult);
    await handle.result;
    expect(service.cancel(handle.runId)).toBe(false);
  });

  it("combines caller cancellation with runtime cancellation", async () => {
    const caller = new AbortController();
    const deferred = createDeferred<AgentRunResult>();
    let signal: AbortSignal | undefined;
    const service = new AgentRunService(async (input) => {
      signal = input.abortSignal;
      return await deferred.promise;
    });
    const handle = service.start({ ...createStartInput(), signal: caller.signal });
    await vi.waitFor(() => expect(signal).toBeDefined());

    const reason = new Error("caller stopped");
    caller.abort(reason);

    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe(reason);
    expect(service.cancel(handle.runId)).toBe(true);
    deferred.resolve(runResult);
    await handle.result;
  });

  it("rejects duplicate active run ids and releases them after settlement", async () => {
    const first = createDeferred<AgentRunResult>();
    const second = createDeferred<AgentRunResult>();
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => await first.promise)
      .mockImplementationOnce(async () => await second.promise);
    const service = new AgentRunService(execute);
    const firstHandle = service.start(createStartInput());

    expect(() => service.start(createStartInput())).toThrow("agent run already active: run-1");

    first.resolve(runResult);
    await firstHandle.result;
    const secondHandle = service.start(createStartInput());

    expect(firstHandle.cancel()).toBe(false);
    expect(secondHandle.cancel()).toBe(true);
    second.resolve(runResult);
    await secondHandle.result;
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("releases a run id after executor failure", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("run failed"))
      .mockResolvedValueOnce(runResult);
    const service = new AgentRunService(execute);

    await expect(service.start(createStartInput()).result).rejects.toThrow("run failed");
    await expect(service.start(createStartInput()).result).resolves.toBe(runResult);
  });
});
