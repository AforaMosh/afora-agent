/** Projects one process-local OpenClaw turn onto ACP session updates. */
import type { SessionUpdate, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { toErrorObject } from "../infra/errors.js";
import { resolveAssistantEventPhase } from "../shared/chat-message-content.js";
import {
  extractToolCallContent,
  extractToolCallLocations,
  formatToolTitle,
  inferToolKind,
} from "./event-mapper.js";
import type { AcpLocalSessionRuntime } from "./local-session-runtime.js";
import type { AcpLocalTurnSession } from "./local-turn-runtime.js";
import type { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

export type AcpLocalTurnProjectionState = {
  sessionId: string;
  sessionKey: string;
  ledgerSessionId?: string;
  sentText: string;
  sentThought: string;
  toolCalls: Map<
    string,
    {
      title: string;
      kind: ToolKind;
      rawInput?: Record<string, unknown>;
      locations?: ToolCallLocation[];
    }
  >;
  eventTail: Promise<void>;
  error?: unknown;
  terminalError?: Error;
  lifecycleStopReason?: string;
  lifecycleAborted: boolean;
};

function appendAssistantText(params: { previous: string; text?: unknown; delta?: unknown }): {
  full: string;
  chunk: string;
} {
  const text = typeof params.text === "string" ? params.text : "";
  const delta = typeof params.delta === "string" ? params.delta : "";
  if (text) {
    if (text === params.previous || params.previous.startsWith(text)) {
      return { full: params.previous, chunk: "" };
    }
    if (text.startsWith(params.previous)) {
      return { full: text, chunk: text.slice(params.previous.length) };
    }
  }
  if (delta) {
    return { full: `${params.previous}${delta}`, chunk: delta };
  }
  return text
    ? { full: `${params.previous}${text}`, chunk: text }
    : { full: params.previous, chunk: "" };
}

function eventError(data: Record<string, unknown>, fallback: string): Error {
  for (const key of ["error", "message", "reason"] as const) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      return new Error(value);
    }
  }
  return new Error(fallback);
}

/** Serializes ACP projection so transport failures cannot overtake later run events. */
export class AcpLocalTurnProjection {
  constructor(
    private readonly options: {
      sessionRuntime: AcpLocalSessionRuntime;
      sessionUpdates: AcpTranslatorSessionUpdates;
      log: (message: string) => void;
    },
  ) {}

  createState(session: AcpLocalTurnSession): AcpLocalTurnProjectionState {
    return {
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
      sentText: "",
      sentThought: "",
      toolCalls: new Map(),
      eventTail: Promise.resolve(),
      lifecycleAborted: false,
    };
  }

  enqueue(state: AcpLocalTurnProjectionState, event: AgentEventPayload): void {
    state.eventTail = state.eventTail.then(async () => {
      try {
        await this.handleAgentEvent(state, event);
      } catch (error) {
        state.error ??= error;
        this.options.log(`event projection failed for ${event.runId}: ${String(error)}`);
      }
    });
  }

  async finalize(
    state: AcpLocalTurnProjectionState,
    runId: string,
    finalText: string,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    if (finalText) {
      await this.emitAssistantSnapshot(state, runId, finalText);
      if (!isCurrent()) {
        return false;
      }
    }
    await this.finalizeOpenToolCalls(state, runId, "Tool call ended without reporting a result.");
    if (!isCurrent()) {
      return false;
    }
    const snapshot = await this.options.sessionRuntime.getSessionSnapshot(state.sessionKey);
    if (!isCurrent()) {
      return false;
    }
    await this.sendSessionSnapshotUpdate(state, snapshot, runId);
    return isCurrent();
  }

  async finalizeOpenToolCalls(
    state: AcpLocalTurnProjectionState,
    runId: string,
    reason: string,
  ): Promise<void> {
    let firstError: Error | undefined;
    for (const [toolCallId, tool] of state.toolCalls) {
      try {
        await this.emitTurnUpdate(state, runId, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          rawOutput: reason,
          content: extractToolCallContent(reason),
          locations: tool.locations,
        });
        state.toolCalls.delete(toolCallId);
      } catch (error) {
        firstError ??= toErrorObject(error, "ACP tool-call finalization failed");
      }
    }
    if (firstError) {
      throw firstError;
    }
  }

  private async handleAgentEvent(
    state: AcpLocalTurnProjectionState,
    event: AgentEventPayload,
  ): Promise<void> {
    if (event.stream === "assistant") {
      if (resolveAssistantEventPhase(event.data) === "commentary") {
        return;
      }
      const merged = appendAssistantText({
        previous: state.sentText,
        text: event.data.text,
        delta: event.data.delta,
      });
      state.sentText = merged.full;
      if (merged.chunk) {
        await this.emitTurnUpdate(state, event.runId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: merged.chunk },
        });
      }
      return;
    }
    if (event.stream === "thinking") {
      const merged = appendAssistantText({
        previous: state.sentThought,
        text: event.data.text,
        delta: event.data.delta,
      });
      state.sentThought = merged.full;
      if (merged.chunk) {
        await this.emitTurnUpdate(state, event.runId, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: merged.chunk },
        });
      }
      return;
    }
    if (event.stream === "tool") {
      await this.handleToolEvent(state, event);
      return;
    }
    if (event.stream === "error") {
      state.terminalError = eventError(event.data, "Agent run failed");
      return;
    }
    if (event.stream === "lifecycle") {
      const phase = event.data.phase;
      if (phase === "start") {
        state.terminalError = undefined;
        state.lifecycleAborted = false;
        state.lifecycleStopReason = undefined;
      } else if (phase === "error") {
        state.terminalError = eventError(event.data, "Agent run failed");
      }
      if ((phase === "finishing" || phase === "end") && typeof event.data.stopReason === "string") {
        state.lifecycleStopReason = event.data.stopReason;
      }
      if (phase === "end" || phase === "error") {
        state.lifecycleAborted = event.data.aborted === true;
      }
    }
  }

  private async handleToolEvent(
    state: AcpLocalTurnProjectionState,
    event: AgentEventPayload,
  ): Promise<void> {
    const phase = event.data.phase;
    const toolCallId =
      typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
    if (!toolCallId) {
      return;
    }
    if (phase === "start") {
      if (state.toolCalls.has(toolCallId)) {
        return;
      }
      const args =
        event.data.args && typeof event.data.args === "object" && !Array.isArray(event.data.args)
          ? (event.data.args as Record<string, unknown>)
          : undefined;
      const name = typeof event.data.name === "string" ? event.data.name : undefined;
      const tool = {
        title: formatToolTitle(name, args),
        kind: inferToolKind(name),
        rawInput: args,
        locations: extractToolCallLocations(args),
      };
      state.toolCalls.set(toolCallId, tool);
      await this.emitTurnUpdate(state, event.runId, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: tool.title,
        status: "in_progress",
        rawInput: args,
        kind: tool.kind,
        locations: tool.locations,
      });
      return;
    }
    const tool = state.toolCalls.get(toolCallId);
    const output = phase === "update" ? event.data.partialResult : event.data.result;
    if (phase !== "update" && phase !== "result") {
      return;
    }
    await this.emitTurnUpdate(state, event.runId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status:
        phase === "result" ? (event.data.isError === true ? "failed" : "completed") : "in_progress",
      rawOutput: output,
      content: extractToolCallContent(output),
      locations: extractToolCallLocations(tool?.locations, output),
    });
    if (phase === "result") {
      state.toolCalls.delete(toolCallId);
    }
  }

  private async emitAssistantSnapshot(
    state: AcpLocalTurnProjectionState,
    runId: string,
    text: string,
  ): Promise<void> {
    const merged = appendAssistantText({ previous: state.sentText, text });
    state.sentText = merged.full;
    if (!merged.chunk) {
      return;
    }
    await this.emitTurnUpdate(state, runId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: merged.chunk },
    });
  }

  private async emitTurnUpdate(
    state: AcpLocalTurnProjectionState,
    runId: string | undefined,
    update: SessionUpdate,
  ): Promise<void> {
    await this.options.sessionUpdates.emit({
      sessionId: state.sessionId,
      sessionKey: state.sessionKey,
      ...(state.ledgerSessionId ? { ledgerSessionId: state.ledgerSessionId } : {}),
      ...(runId ? { runId } : {}),
      update,
      record: true,
    });
  }

  private async sendSessionSnapshotUpdate(
    state: AcpLocalTurnProjectionState,
    snapshot: Awaited<ReturnType<AcpLocalSessionRuntime["getSessionSnapshot"]>>,
    runId: string,
  ): Promise<void> {
    const common = {
      sessionId: state.sessionId,
      sessionKey: state.sessionKey,
      ...(state.ledgerSessionId ? { ledgerSessionId: state.ledgerSessionId } : {}),
      runId,
      record: true,
    };
    if (snapshot.metadata) {
      await this.options.sessionUpdates.emit({
        ...common,
        update: {
          sessionUpdate: "session_info_update",
          ...snapshot.metadata,
        },
      });
    }
    if (snapshot.usage) {
      await this.options.sessionUpdates.emit({
        ...common,
        update: {
          sessionUpdate: "usage_update",
          used: snapshot.usage.used,
          size: snapshot.usage.size,
          _meta: {
            source: "local-session-store",
            approximate: true,
          },
        },
      });
    }
  }
}
