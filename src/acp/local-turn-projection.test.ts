import type { AgentSideConnection, SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { AgentEventPayload, AgentEventStream } from "../infra/agent-events.js";
import type { AcpEventLedger, AcpEventLedgerReplay } from "./event-ledger.js";
import { createInMemoryAcpEventLedger } from "./event-ledger.test-support.js";
import type { AcpLocalSessionRuntime } from "./local-session-runtime.js";
import { AcpLocalTurnProjection } from "./local-turn-projection.js";
import type { AcpLocalTurnSession } from "./local-turn-runtime.js";
import { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

const session: AcpLocalTurnSession = {
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  cwd: "/tmp/acp-project",
};

function createSessionRuntime(): AcpLocalSessionRuntime {
  const snapshot = {
    configOptions: [],
    modes: {
      currentModeId: "adaptive",
      availableModes: [{ id: "adaptive", name: "Adaptive" }],
    },
  };
  return {
    resolveSessionKey: async ({ fallbackKey }) => fallbackKey,
    resetSessionIfNeeded: async () => {},
    getSessionSnapshot: async () => snapshot,
    getExistingSessionSnapshot: async () => snapshot,
    patchSession: async () => snapshot,
    listSessions: async () => [],
    getSessionTranscript: async () => [],
  };
}

function textUpdates(
  updates: readonly SessionUpdate[],
  kind: "agent_message_chunk" | "agent_thought_chunk",
): string[] {
  return updates.flatMap((update) =>
    update.sessionUpdate === kind && update.content.type === "text" ? [update.content.text] : [],
  );
}

function replayTextUpdates(
  replay: AcpEventLedgerReplay,
  kind: "agent_message_chunk" | "agent_thought_chunk",
): string[] {
  return textUpdates(
    replay.events.map((event) => event.update),
    kind,
  );
}

async function createHarness() {
  const updates: SessionUpdate[] = [];
  const eventLedger = createInMemoryAcpEventLedger();
  await eventLedger.startSession({
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    cwd: session.cwd,
    complete: true,
  });
  const sessionUpdates = new AcpTranslatorSessionUpdates({
    connection: {
      requestPermission: vi.fn(),
      sessionUpdate: vi.fn(async ({ update }: { update: SessionUpdate }) => {
        updates.push(update);
      }),
    } as unknown as AgentSideConnection,
    eventLedger,
    getAvailableCommands: async () => [],
    log: () => {},
  });
  const projection = new AcpLocalTurnProjection({
    sessionRuntime: createSessionRuntime(),
    sessionUpdates,
    log: () => {},
  });
  const state = projection.createState(session);
  let seq = 0;
  const enqueue = (stream: AgentEventStream, data: Record<string, unknown>) => {
    projection.enqueue(state, {
      runId: "run-1",
      seq: ++seq,
      stream,
      ts: seq,
      data,
    } satisfies AgentEventPayload);
  };
  const finalize = async (finalText = "") => {
    await state.eventTail;
    return await projection.finalize(state, "run-1", finalText, () => true);
  };
  return { enqueue, eventLedger, finalize, projection, state, updates };
}

async function readReplay(eventLedger: AcpEventLedger) {
  return await eventLedger.readReplay({
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
  });
}

describe("AcpLocalTurnProjection", () => {
  it("streams prefix-compatible replacements across assistant block boundaries", async () => {
    const harness = await createHarness();
    harness.projection.enqueueAssistantMessageStart(harness.state);
    harness.enqueue("assistant", { text: "one" });
    harness.enqueue("assistant", { text: "one revised", replace: true });
    harness.projection.enqueueAssistantMessageStart(harness.state);
    harness.enqueue("assistant", { text: "two" });

    await harness.finalize("one revised\n\ntwo");

    expect(textUpdates(harness.updates, "agent_message_chunk")).toEqual([
      "one",
      " revised",
      "\n\ntwo",
    ]);
  });

  it("buffers replaceable assistant snapshots and records the canonical final once", async () => {
    const harness = await createHarness();
    harness.projection.enqueueAssistantMessageStart(harness.state);
    harness.enqueue("assistant", {
      text: "coordination ",
      delta: "coordination ",
      replaceable: true,
    });
    harness.enqueue("assistant", {
      text: "coordination draft",
      delta: "draft",
      replaceable: true,
    });
    harness.enqueue("assistant", {
      text: "final ",
      delta: "",
      replace: true,
      replaceable: true,
    });
    harness.enqueue("assistant", {
      text: "final answer",
      delta: "answer",
      replaceable: true,
    });

    await harness.finalize("final answer");

    expect(textUpdates(harness.updates, "agent_message_chunk")).toEqual(["final answer"]);
    expect(replayTextUpdates(await readReplay(harness.eventLedger), "agent_message_chunk")).toEqual(
      ["final answer"],
    );
  });

  it("buffers cumulative reasoning snapshots and records only the latest thought", async () => {
    const harness = await createHarness();
    harness.enqueue("thinking", {
      text: "rough draft",
      delta: "rough draft",
      isReasoningSnapshot: true,
    });
    harness.enqueue("thinking", {
      text: "revised thought",
      delta: "revised thought",
      isReasoningSnapshot: true,
    });

    await harness.finalize("answer");

    expect(textUpdates(harness.updates, "agent_thought_chunk")).toEqual(["revised thought"]);
    expect(replayTextUpdates(await readReplay(harness.eventLedger), "agent_thought_chunk")).toEqual(
      ["revised thought"],
    );
  });

  it("allows replaceable assistant snapshots to clear buffered output", async () => {
    const harness = await createHarness();
    harness.enqueue("assistant", { text: "discarded draft", replaceable: true });
    harness.enqueue("assistant", { text: "", replace: true, replaceable: true });

    await harness.finalize();

    expect(textUpdates(harness.updates, "agent_message_chunk")).toEqual([]);
  });

  it("allows cumulative reasoning snapshots to clear buffered thoughts", async () => {
    const harness = await createHarness();
    harness.enqueue("thinking", {
      text: "discarded thought",
      isReasoningSnapshot: true,
    });
    harness.enqueue("thinking", { text: "", isReasoningSnapshot: true });

    await harness.finalize();

    expect(textUpdates(harness.updates, "agent_thought_chunk")).toEqual([]);
  });

  it("rejects a non-prefix replacement after assistant bytes are committed", async () => {
    const harness = await createHarness();
    harness.enqueue("assistant", { text: "draft", delta: "draft" });
    harness.enqueue("assistant", { text: "final", delta: "", replace: true });

    await harness.state.eventTail;

    expect(harness.state.error).toEqual(
      new Error(
        "ACP cannot replace committed assistant output; providers must mark replacement-capable output as replaceable before emitting it",
      ),
    );
  });
});
