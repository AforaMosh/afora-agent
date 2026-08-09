import { describe, expect, it } from "vitest";
import {
  validateWorkerTranscriptCommitParams,
  WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES,
} from "../../packages/gateway-protocol/src/index.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import type { AssistantMessage } from "../llm/types.js";
import { toAgentMessage } from "./embedded-agent-transcript.runtime.js";
import {
  isWorkerTranscriptMessageFrameSafe,
  toWorkerTranscriptMessage,
} from "./transcript-message.js";

const providerReplay = {
  v: 1 as const,
  type: "openai-responses-compaction",
  id: "cmp_worker_projection",
  data: "opaque-worker-projection",
  replayIndex: 1,
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.6-luna",
  baseUrlHash: "ozhevd1smnk8s",
  sessionHash: "171dzdv17gum5g",
  authProfileHash: "oe8bkr3r8947",
};

function assistantWithReplay(
  replay: AssistantMessage["providerReplay"] = structuredClone(providerReplay),
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "visible" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.6-luna",
    ...(replay ? { providerReplay: replay } : {}),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

describe("worker transcript provider replay", () => {
  it("projects and restores opaque replay state within frame limits", () => {
    const message = assistantWithReplay();
    Object.assign(message.providerReplay!, { providerScratch: "private" });

    const result = toWorkerTranscriptMessage(message, "transcript");
    expect(result?.kind).toBe("complete");
    if (!result || result.kind !== "complete" || result.message.role !== "assistant") {
      throw new Error("expected projected assistant message");
    }
    const projected = result.message;
    expect(projected.providerReplay).toEqual(providerReplay);
    expect(JSON.stringify(projected)).not.toContain("providerScratch");
    expect(isWorkerTranscriptMessageFrameSafe(projected)).toBe(true);
    expect(
      validateWorkerTranscriptCommitParams({
        runEpoch: 1,
        seq: 1,
        baseLeafId: null,
        messages: [projected],
      }),
    ).toBe(true);
    expect(toAgentMessage(projected)).toMatchObject({ providerReplay });
  });

  it("keeps replay above 48 KiB whole when the complete commit frame fits", () => {
    const ciphertext = `cipher-${"x".repeat(60 * 1024)}-€`;
    const message = assistantWithReplay({
      ...providerReplay,
      data: ciphertext,
    });

    const result = toWorkerTranscriptMessage(message, "transcript");

    expect(result?.kind).toBe("complete");
    if (!result || result.kind !== "complete" || result.message.role !== "assistant") {
      throw new Error("expected projected assistant message");
    }
    expect(result.message.providerReplay?.data).toBe(ciphertext);
    expect(isWorkerTranscriptMessageFrameSafe(result.message)).toBe(true);
  });

  it.each([
    {
      name: "raw UTF-8 data over the replay field budget",
      replay: { ...providerReplay, data: "x".repeat(WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES + 1) },
      reason: "provider-replay-data-budget" as const,
    },
    {
      name: "multibyte data whose complete frame is over budget",
      replay: { ...providerReplay, data: "€".repeat(21_845) },
      reason: "transcript-commit-frame-budget" as const,
    },
    {
      name: "JSON-escaped data over the complete frame budget",
      replay: { ...providerReplay, data: "\0".repeat(12_000) },
      reason: "transcript-commit-frame-budget" as const,
    },
    {
      name: "a schema-valid id over the complete frame budget",
      replay: { ...providerReplay, id: "i".repeat(65_536), data: "opaque" },
      reason: "transcript-commit-frame-budget" as const,
    },
  ])("degrades without ciphertext for $name", ({ replay, reason }) => {
    const result = toWorkerTranscriptMessage(assistantWithReplay(replay), "transcript");

    if (!result || result.kind !== "provider-replay-unavailable") {
      throw new Error("expected degraded replay projection");
    }
    expect(result.details).toMatchObject({ reason });
    expect(JSON.stringify(result.details)).not.toContain(replay.data);
  });
});

describe("worker transcript durable media projection", () => {
  it("fully redacts prefixed line-wrapped video data URLs from tool details", () => {
    const fragments = ["cHJpdmF0ZS", "12aWRlby1w", "YXlsb2Fk"];
    const message: AgentMessage = {
      role: "toolResult",
      toolCallId: "call-video",
      toolName: "camera",
      content: [{ type: "text", text: "captured" }],
      details: {
        uri: `captured clip: data:video/mp4;base64,${fragments.join(" \t\n")}`,
      },
      isError: false,
      timestamp: 1,
    };

    const result = toWorkerTranscriptMessage(message, "inference");
    expect(result).toMatchObject({
      kind: "complete",
      message: { details: { uri: "captured clip: [media data omitted]" } },
    });
    const serialized = JSON.stringify(result);
    for (const fragment of fragments) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it.each(["contentType", "content_type"] as const)(
    "redacts %s video envelopes before worker transcript delivery",
    (mimeKey) => {
      const payload = "cHJpdmF0ZS13b3JrZXItdmlkZW8=";
      const message: AgentMessage = {
        role: "toolResult",
        toolCallId: "call-video",
        toolName: "camera",
        content: [{ type: "text", text: "captured" }],
        details: {
          nested: { [mimeKey]: "video/mp4", blob: payload },
        },
        isError: false,
        timestamp: 1,
      };

      const result = toWorkerTranscriptMessage(message, "transcript");
      expect(result).toMatchObject({
        kind: "complete",
        message: { details: { nested: "[video data omitted]" } },
      });
      expect(JSON.stringify(result)).not.toContain(payload);
    },
  );

  it("never invokes custom serializers before sizing or serializing worker frames", () => {
    const payload = "private-worker-custom-serializer";
    let calls = 0;
    class SerializerTrap {
      safe = "keep";
      nested = { contentType: "video/mp4", data: payload };
      #payload = payload;
      toJSON() {
        calls += 1;
        return { contentType: "video/mp4", data: this.#payload };
      }
    }
    const message: AgentMessage = {
      role: "toolResult",
      toolCallId: "call-video-json",
      toolName: "camera",
      content: [{ type: "text", text: "captured" }],
      details: { custom: new SerializerTrap() },
      isError: false,
      timestamp: 1,
    };

    const result = toWorkerTranscriptMessage(message, "transcript");
    if (!result || result.kind !== "complete") {
      throw new Error("expected complete worker transcript projection");
    }

    expect(result.message).toMatchObject({
      details: {
        custom: { safe: "keep", nested: "[video data omitted]" },
      },
    });
    expect(calls).toBe(0);
    expect(isWorkerTranscriptMessageFrameSafe(result.message)).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(payload);
    expect(calls).toBe(0);
  });

  it("contains throwing detail getters before worker frame serialization", () => {
    const payload = "private-worker-getter-video";
    const details = {
      nested: { contentType: "video/mp4", data: payload },
    } as Record<string, unknown>;
    let serializerReads = 0;
    Object.defineProperty(details, "toJSON", {
      enumerable: true,
      get() {
        serializerReads += 1;
        throw new Error("synthetic worker toJSON getter failure");
      },
    });
    Object.defineProperty(details, "hiddenMedia", {
      enumerable: true,
      get() {
        throw new Error(`synthetic hidden worker media: ${payload}`);
      },
    });
    const message: AgentMessage = {
      role: "toolResult",
      toolCallId: "call-video-getter",
      toolName: "camera",
      content: [{ type: "text", text: "captured" }],
      details,
      isError: false,
      timestamp: 1,
    };

    const result = toWorkerTranscriptMessage(message, "transcript");
    if (!result || result.kind !== "complete") {
      throw new Error("expected complete worker transcript projection");
    }

    expect(result.message).toMatchObject({
      details: {
        nested: "[video data omitted]",
        hiddenMedia: "[media details omitted: unreadable property]",
      },
    });
    expect(result.message.details).not.toHaveProperty("toJSON");
    expect(serializerReads).toBe(0);
    expect(isWorkerTranscriptMessageFrameSafe(result.message)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(payload);
    expect(serializerReads).toBe(0);
  });

  it("detaches earlier details before a later getter mutates their source", () => {
    const payload = "private-worker-late-getter-video";
    const victim = { note: "safe before getter" } as Record<string, unknown>;
    const details = { victim } as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(details, "mutator", {
      enumerable: true,
      get() {
        reads += 1;
        victim.contentType = "video/mp4";
        victim.data = payload;
        return "mutation complete";
      },
    });
    const message: AgentMessage = {
      role: "toolResult",
      toolCallId: "call-late-getter",
      toolName: "camera",
      content: [{ type: "text", text: "captured" }],
      details,
      isError: false,
      timestamp: 1,
    };

    const result = toWorkerTranscriptMessage(message, "transcript");
    if (!result || result.kind !== "complete") {
      throw new Error("expected complete worker transcript projection");
    }

    expect(reads).toBe(1);
    expect(victim).toMatchObject({ contentType: "video/mp4", data: payload });
    expect(result.message).toMatchObject({
      details: {
        victim: { note: "safe before getter" },
        mutator: "mutation complete",
      },
    });
    expect(isWorkerTranscriptMessageFrameSafe(result.message)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(payload);
  });

  it("bounds deep worker details before cloning or frame serialization", () => {
    let details: Record<string, unknown> = { leaf: "safe" };
    for (let depth = 0; depth < 10_000; depth += 1) {
      details = { nested: details };
    }
    const message: AgentMessage = {
      role: "toolResult",
      toolCallId: "call-deep-details",
      toolName: "deep",
      content: [{ type: "text", text: "captured" }],
      details,
      isError: false,
      timestamp: 1,
    };

    let result: ReturnType<typeof toWorkerTranscriptMessage> = undefined;
    expect(() => {
      result = toWorkerTranscriptMessage(message, "transcript");
    }).not.toThrow();
    expect(JSON.stringify(result)).toContain("[media details omitted: limit exceeded]");
  });

  it("bounds worker detail value counts before cloning the full collection", () => {
    const message: AgentMessage = {
      role: "toolResult",
      toolCallId: "call-wide-details",
      toolName: "wide",
      content: [{ type: "text", text: "captured" }],
      details: { values: Array.from({ length: 2_001 }, (_, index) => index) },
      isError: false,
      timestamp: 1,
    };

    const result = toWorkerTranscriptMessage(message, "transcript");
    expect(result).toMatchObject({
      kind: "complete",
      message: { details: { values: "[media details omitted: limit exceeded]" } },
    });
  });

  it("bounds aggregate worker detail strings before frame serialization", () => {
    const message: AgentMessage = {
      role: "toolResult",
      toolCallId: "call-long-details",
      toolName: "long",
      content: [{ type: "text", text: "captured" }],
      details: { payload: "x".repeat(1_000_001) },
      isError: false,
      timestamp: 1,
    };

    const result = toWorkerTranscriptMessage(message, "transcript");
    expect(result).toMatchObject({
      kind: "complete",
      message: { details: { payload: "[media details omitted: limit exceeded]" } },
    });
    if (!result || result.kind !== "complete") {
      throw new Error("expected complete worker projection");
    }
    expect(isWorkerTranscriptMessageFrameSafe(result.message)).toBe(true);
  });

  it("reports a bounded but oversized worker transcript frame without crashing", () => {
    const message: AgentMessage = {
      role: "toolResult",
      toolCallId: "call-frame-details",
      toolName: "frame",
      content: [{ type: "text", text: "captured" }],
      details: { payload: "x".repeat(128 * 1_024) },
      isError: false,
      timestamp: 1,
    };

    const result = toWorkerTranscriptMessage(message, "transcript");
    if (!result || result.kind !== "complete") {
      throw new Error("expected complete worker projection");
    }
    expect(isWorkerTranscriptMessageFrameSafe(result.message)).toBe(false);
  });
});
