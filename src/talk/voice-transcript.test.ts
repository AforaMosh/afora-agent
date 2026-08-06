import { describe, expect, it, vi } from "vitest";
import {
  createVoiceTranscriptOperationRegistry,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "./voice-transcript.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("VoiceTranscriptOperationRegistry", () => {
  it("keeps overflow terminal through drain and releases it only on close", async () => {
    const registry = createVoiceTranscriptOperationRegistry(VOICE_TRANSCRIPT_QUEUE_POLICY);
    const first = deferred();
    const key = "agent\0voice-overflow";
    const accepted = [
      registry.run(key, async () => await first.promise),
      ...Array.from({ length: VOICE_TRANSCRIPT_QUEUE_POLICY.maxPendingCount }, () =>
        registry.run(key, async () => undefined),
      ),
    ];

    await expect(registry.run(key, async () => undefined)).rejects.toThrow(
      "voice transcript persistence queue capacity exceeded",
    );
    first.resolve();
    await Promise.all(accepted);

    const controlOperation = vi.fn();
    await expect(
      registry.run(key, controlOperation, { weight: 0, waitForCapacity: true }),
    ).rejects.toThrow("voice transcript persistence queue capacity exceeded");
    expect(controlOperation).not.toHaveBeenCalled();

    const closeOperation = vi.fn();
    await registry.close(key, "", async () => {
      closeOperation();
    });
    expect(closeOperation).toHaveBeenCalledOnce();
    await expect(
      registry.run(key, controlOperation, { weight: 0, waitForCapacity: true }),
    ).resolves.toBeUndefined();
    expect(controlOperation).toHaveBeenCalledOnce();
  });

  it("dedupes identical close fences and serializes distinct failures", async () => {
    const registry = createVoiceTranscriptOperationRegistry(VOICE_TRANSCRIPT_QUEUE_POLICY);
    const gate = deferred();
    const order: string[] = [];
    const first = vi.fn(async () => {
      order.push("a:start");
      await gate.promise;
      order.push("a:fail");
      throw new Error("close A failed");
    });
    const second = vi.fn(async () => {
      order.push("b");
    });

    const closeA = registry.close("agent\0voice-fenced", "allocation-a", first);
    const duplicateA = registry.close("agent\0voice-fenced", "allocation-a", first);
    const closeB = registry.close("agent\0voice-fenced", "allocation-b", second);
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    expect(second).not.toHaveBeenCalled();

    gate.resolve();
    await expect(closeA).rejects.toThrow("close A failed");
    await expect(duplicateA).rejects.toThrow("close A failed");
    await expect(closeB).resolves.toBeUndefined();
    expect(order).toEqual(["a:start", "a:fail", "b"]);
  });
});
