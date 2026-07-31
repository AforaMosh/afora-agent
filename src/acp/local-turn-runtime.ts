/** Process-local ACP prompt execution over the canonical OpenClaw agent runner. */
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { AgentSideConnection, PromptRequest, PromptResponse } from "@agentclientprotocol/sdk";
import { readBool, readNonNegativeInteger, readString } from "@openclaw/acp-core/meta";
import type { AcpServerOptions, AcpSessionRuntimeOptions } from "@openclaw/acp-core/types";
import { normalizeFastMode } from "@openclaw/normalization-core/string-coerce";
import { agentCommandFromIngress } from "../agents/agent-command.js";
import { LocalAgentHost } from "../agents/local-agent-host.js";
import { toErrorObject } from "../infra/errors.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { createAcpApprovalHost } from "./approval-host.js";
import { extractAttachmentsFromPrompt, extractTextFromPrompt } from "./event-mapper.js";
import type { AcpLocalSessionRuntime } from "./local-session-runtime.js";
import {
  AcpLocalTurnProjection,
  type AcpLocalTurnProjectionState,
} from "./local-turn-projection.js";
import type { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

const MAX_PROMPT_BYTES = 2 * 1024 * 1024;

const silentRuntime: RuntimeEnv = {
  log: () => {},
  error: () => {},
  exit: (code: number) => {
    throw new Error(`unexpected agent runtime exit ${code}`);
  },
};

type AgentExecutor = typeof agentCommandFromIngress;
type AgentResult = Awaited<ReturnType<AgentExecutor>>;

export type AcpLocalTurnSession = {
  sessionId: string;
  sessionKey: string;
  ledgerSessionId?: string;
  cwd: string;
  runtimeOptions?: AcpSessionRuntimeOptions;
};

type AcpLocalTurnRuntimeOptions = Pick<AcpServerOptions, "prefixCwd" | "provenanceMode"> & {
  connection: AgentSideConnection;
  sessionRuntime: AcpLocalSessionRuntime;
  sessionUpdates: AcpTranslatorSessionUpdates;
  executeAgent?: AgentExecutor;
  createRunId?: () => string;
  runtime?: RuntimeEnv;
  log?: (message: string) => void;
};

type AcpTurnState = {
  projection: AcpLocalTurnProjectionState;
  runtimeOptions: AcpSessionRuntimeOptions;
};

type PreparedAcpPrompt = {
  attachments: ReturnType<typeof extractAttachmentsFromPrompt>;
  message: string;
  userText: string;
};

function payloadText(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const payload = part as { isReasoning?: unknown; text?: unknown };
      if (payload.isReasoning === true) {
        return "";
      }
      const text = payload.text;
      return typeof text === "string" ? text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function normalizeStopReason(value: unknown): PromptResponse["stopReason"] {
  if (
    value === "max_tokens" ||
    value === "max_turn_requests" ||
    value === "refusal" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "end_turn";
}

function timeoutSeconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return String(Math.ceil(value));
}

function buildSystemProvenanceReceipt(params: {
  cwd: string;
  sessionId: string;
  sessionKey: string;
}): string {
  return [
    "[Source Receipt]",
    "adapter=openclaw-acp",
    `originHost=${os.hostname()}`,
    `originCwd=${shortenHomePath(params.cwd)}`,
    `acpSessionId=${params.sessionId}`,
    `targetSession=${params.sessionKey}`,
    "[/Source Receipt]",
  ].join("\n");
}

function runtimeOptions(session: AcpLocalTurnSession): AcpSessionRuntimeOptions {
  return session.runtimeOptions ?? {};
}

/**
 * Owns process-local ACP turns and their projections.
 *
 * Session binding, reset, and protocol lifecycle remain outside this runtime.
 */
export class AcpLocalTurnRuntime {
  private readonly executeAgent: AgentExecutor;
  private readonly createRunId: () => string;
  private readonly runtime: RuntimeEnv;
  private readonly log: (message: string) => void;
  private readonly projection: AcpLocalTurnProjection;
  private readonly host = new LocalAgentHost<AcpTurnState, PromptResponse>();
  private readonly promptCompletions = new Map<
    Promise<PromptResponse>,
    { sessionId: string; sessionKey: string }
  >();
  private readonly sessionTransitions = new KeyedAsyncQueue();
  private readonly pendingTransitionCommits = new Set<Promise<void>>();
  private readonly promptRequestGenerations = new Map<string, number>();
  private readonly promptGenerations = new Map<string, number>();
  private shutdownPromise?: Promise<void>;
  private stopped = false;

  constructor(private readonly options: AcpLocalTurnRuntimeOptions) {
    this.executeAgent = options.executeAgent ?? agentCommandFromIngress;
    this.createRunId = options.createRunId ?? randomUUID;
    this.runtime = options.runtime ?? silentRuntime;
    this.log = options.log ?? (() => {});
    this.projection = new AcpLocalTurnProjection({
      sessionRuntime: options.sessionRuntime,
      sessionUpdates: options.sessionUpdates,
      log: this.log,
    });
  }

  activeRunCount(): number {
    return this.host.list().length;
  }

  activeSessionIds(): ReadonlySet<string> {
    return new Set([...this.promptCompletions.values()].map((entry) => entry.sessionId));
  }

  prompt(session: AcpLocalTurnSession, params: PromptRequest): Promise<PromptResponse> {
    if (params.sessionId !== session.sessionId) {
      return Promise.reject(new Error(`Session ${params.sessionId} does not match its binding`));
    }
    let prepared: PreparedAcpPrompt;
    try {
      prepared = this.preparePrompt(session, params);
    } catch (error) {
      return Promise.reject(toErrorObject(error, "ACP prompt preparation failed"));
    }
    const requestGeneration = this.reservePromptRequest(session.sessionId);
    const completion = this.runPrompt(session, params, prepared, requestGeneration);
    this.promptCompletions.set(completion, {
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
    });
    const clearCompletion = () => {
      this.promptCompletions.delete(completion);
      if (
        ![...this.promptCompletions.values()].some((entry) => entry.sessionId === session.sessionId)
      ) {
        this.promptGenerations.delete(session.sessionId);
        this.promptRequestGenerations.delete(session.sessionId);
      }
    };
    void completion.then(clearCompletion, clearCompletion);
    return completion;
  }

  async cancel(sessionId: string, reason: unknown = new Error("ACP prompt cancelled")) {
    if (this.stopped) {
      return;
    }
    if (!this.promptGenerations.has(sessionId) && !this.promptRequestGenerations.has(sessionId)) {
      return;
    }
    const generation = this.reservePromptRequest(sessionId);
    this.requestSessionTurnCancel(sessionId, reason);
    const commit = this.sessionTransitions.enqueue(sessionId, async () => {
      this.commitReservedGeneration(sessionId, generation);
    });
    this.pendingTransitionCommits.add(commit);
    const clearCommit = () => {
      this.pendingTransitionCommits.delete(commit);
    };
    void commit.then(clearCommit, clearCommit);
  }

  async quiesceSession(
    sessionId: string,
    reason: unknown = new Error("ACP session reconfigured"),
  ): Promise<void> {
    const generation = this.reservePromptRequest(sessionId);
    const turn = this.requestSessionTurnCancel(sessionId, reason);
    await this.sessionTransitions.enqueue(sessionId, async () => {
      this.commitReservedGeneration(sessionId, generation);
    });
    if (turn) {
      await turn.result.catch(() => {});
      await turn.adapterState.projection.eventTail;
    }
    const completions = [...this.promptCompletions.entries()]
      .filter(([, entry]) => entry.sessionId === sessionId)
      .map(([completion]) => completion);
    await Promise.allSettled(completions);
    if (![...this.promptCompletions.values()].some((entry) => entry.sessionId === sessionId)) {
      this.promptGenerations.delete(sessionId);
      this.promptRequestGenerations.delete(sessionId);
    }
  }

  shutdown(reason: unknown = new Error("ACP runtime stopped")): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.stopped = true;
    this.shutdownPromise = (async () => {
      const turns = this.host.seal();
      for (const turn of turns) {
        turn.cancel(reason);
      }
      await Promise.allSettled(turns.map((turn) => turn.result));
      await Promise.allSettled(turns.map((turn) => turn.adapterState.projection.eventTail));
      await Promise.allSettled(this.promptCompletions.keys());
      await Promise.allSettled(this.pendingTransitionCommits);
      this.promptGenerations.clear();
      this.promptRequestGenerations.clear();
    })();
    return this.shutdownPromise;
  }

  private async runPrompt(
    session: AcpLocalTurnSession,
    params: PromptRequest,
    prepared: PreparedAcpPrompt,
    requestGeneration: number,
  ): Promise<PromptResponse> {
    this.assertRunning();
    const generation = await this.sessionTransitions.enqueue(session.sessionId, async () => {
      if (this.stopped || !this.isLatestPromptRequest(session.sessionId, requestGeneration)) {
        return undefined;
      }
      this.promptGenerations.set(session.sessionId, requestGeneration);
      return requestGeneration;
    });
    if (generation === undefined) {
      return { stopReason: "cancelled" };
    }
    await this.cancelSessionTurn(session.sessionId, new Error("ACP prompt superseded"));
    if (!this.isLatestPrompt(session.sessionId, generation)) {
      return { stopReason: "cancelled" };
    }

    const runId = this.createRunId();
    const currentRuntimeOptions = runtimeOptions(session);
    const state: AcpTurnState = {
      projection: this.projection.createState(session),
      runtimeOptions: currentRuntimeOptions,
    };

    await this.options.sessionUpdates.recordUserPrompt(session, runId, params.prompt, () =>
      this.isLatestPrompt(session.sessionId, generation),
    );
    if (!this.isLatestPrompt(session.sessionId, generation)) {
      return { stopReason: "cancelled" };
    }

    const turn = this.host.startTurn({
      runId,
      sessionKey: session.sessionKey,
      adapterState: state,
      onEvent: (event) => {
        this.projection.enqueue(state.projection, event);
      },
      execute: async (signal) => {
        let result: AgentResult | undefined;
        let executionError: unknown;
        try {
          result = await this.executeAgent(
            {
              message:
                this.options.provenanceMode === "meta+receipt"
                  ? `${buildSystemProvenanceReceipt({
                      cwd: session.cwd,
                      sessionId: session.sessionId,
                      sessionKey: session.sessionKey,
                    })}\n\n${prepared.message}`
                  : prepared.message,
              transcriptMessage: prepared.userText,
              images: prepared.attachments.map((attachment) => ({
                type: "image" as const,
                data: attachment.content,
                mimeType: attachment.mimeType,
              })),
              sessionKey: session.sessionKey,
              thinking:
                readString(params["_meta"], ["thinking", "thinkingLevel"]) ??
                currentRuntimeOptions.thinking,
              verbose: currentRuntimeOptions.backendExtras?.verbose,
              fastMode: normalizeFastMode(currentRuntimeOptions.backendExtras?.fastMode),
              deliver: false,
              channel: INTERNAL_MESSAGE_CHANNEL,
              runContext: {
                messageChannel: INTERNAL_MESSAGE_CHANNEL,
                currentChannelId: INTERNAL_MESSAGE_CHANNEL,
              },
              cwd: session.cwd,
              timeout:
                timeoutSeconds(
                  (() => {
                    const timeoutMs = readNonNegativeInteger(params["_meta"], ["timeoutMs"]);
                    return timeoutMs === undefined ? undefined : timeoutMs / 1_000;
                  })(),
                ) ?? timeoutSeconds(currentRuntimeOptions.timeoutSeconds),
              runId,
              approvalHost: createAcpApprovalHost({
                connection: this.options.connection,
                sessionId: session.sessionId,
              }),
              onAssistantMessageStart: () => {
                this.projection.enqueueAssistantMessageStart(state.projection);
              },
              abortSignal: signal,
              allowModelOverride: false,
              senderIsOwner: true,
              ...(this.options.provenanceMode === "off" || this.options.provenanceMode === undefined
                ? {}
                : {
                    inputProvenance: {
                      kind: "external_user" as const,
                      sourceChannel: "acp",
                    },
                  }),
            },
            this.runtime,
          );
        } catch (error) {
          executionError = error;
        }
        await state.projection.eventTail;
        return await this.finalizeTurn({
          state,
          runId,
          signal,
          generation,
          result,
          executionError,
        });
      },
    });

    return await turn.result;
  }

  private async finalizeTurn(params: {
    state: AcpTurnState;
    runId: string;
    signal: AbortSignal;
    generation: number;
    result?: AgentResult;
    executionError?: unknown;
  }): Promise<PromptResponse> {
    const { state, runId, signal, generation, result, executionError } = params;
    const projection = state.projection;
    if (signal.aborted || !this.isCurrentPrompt(projection.sessionId, generation)) {
      await this.finalizeOpenTools({
        state,
        runId,
        reason: "Turn cancelled.",
      });
      return { stopReason: "cancelled" };
    }
    if (projection.error) {
      const error = projection.error;
      await this.finalizeOpenTools({
        state,
        runId,
        reason: "Turn failed while projecting agent output.",
      });
      throw toErrorObject(error, "ACP projection failed");
    }
    if (executionError) {
      await this.finalizeOpenTools({
        state,
        runId,
        reason: "Turn execution failed.",
      });
      throw toErrorObject(executionError, "ACP turn execution failed");
    }
    if (projection.terminalError) {
      const error = projection.terminalError;
      await this.finalizeOpenTools({
        state,
        runId,
        reason: "Agent run failed.",
      });
      throw error;
    }
    if (projection.lifecycleAborted || result?.meta?.aborted === true) {
      await this.finalizeOpenTools({
        state,
        runId,
        reason: "Turn cancelled.",
      });
      return { stopReason: "cancelled" };
    }

    const finalText = payloadText(result?.payloads);
    let projected: boolean;
    try {
      projected = await this.sessionTransitions.enqueue(projection.sessionId, async () => {
        const isCurrent = () =>
          !signal.aborted && this.isCurrentPrompt(projection.sessionId, generation);
        if (!isCurrent()) {
          return false;
        }
        return await this.projection.finalize(projection, runId, finalText, isCurrent);
      });
    } catch (error) {
      await this.finalizeOpenTools({
        state,
        runId,
        reason: "Turn failed while finalizing agent output.",
      });
      throw error;
    }
    if (!projected) {
      await this.finalizeOpenTools({
        state,
        runId,
        reason: "Turn cancelled.",
      });
      return { stopReason: "cancelled" };
    }
    if (signal.aborted) {
      return { stopReason: "cancelled" };
    }
    return {
      stopReason: normalizeStopReason(projection.lifecycleStopReason ?? result?.meta?.stopReason),
    };
  }

  private async finalizeOpenTools(params: {
    state: AcpTurnState;
    runId: string;
    reason: string;
  }): Promise<void> {
    try {
      await this.projection.finalizeOpenToolCalls(
        params.state.projection,
        params.runId,
        params.reason,
      );
    } catch (error) {
      this.log(`failed to terminalize ACP tool calls for ${params.runId}: ${String(error)}`);
    }
  }

  private async cancelSessionTurn(sessionId: string, reason: unknown): Promise<void> {
    const turn = this.requestSessionTurnCancel(sessionId, reason);
    if (!turn) {
      return;
    }
    await turn.result.catch(() => {});
    await turn.adapterState.projection.eventTail;
  }

  private requestSessionTurnCancel(sessionId: string, reason: unknown) {
    const turn = this.host
      .list()
      .find((candidate) => candidate.adapterState.projection.sessionId === sessionId);
    turn?.cancel(reason);
    return turn;
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new Error("ACP turn runtime is stopped");
    }
  }

  private preparePrompt(session: AcpLocalTurnSession, params: PromptRequest): PreparedAcpPrompt {
    const userText = extractTextFromPrompt(params.prompt, MAX_PROMPT_BYTES);
    const attachments = extractAttachmentsFromPrompt(params.prompt);
    const prefixCwd = readBool(params["_meta"], ["prefixCwd"]) ?? this.options.prefixCwd ?? true;
    const message = prefixCwd
      ? `[Working directory: ${shortenHomePath(session.cwd)}]\n\n${userText}`
      : userText;
    const promptBytes =
      Buffer.byteLength(message, "utf8") +
      attachments.reduce(
        (total, attachment) => total + Buffer.byteLength(attachment.content, "base64"),
        0,
      );
    if (promptBytes > MAX_PROMPT_BYTES) {
      throw new Error(`Prompt exceeds maximum allowed size of ${MAX_PROMPT_BYTES} bytes`);
    }
    return { attachments, message, userText };
  }

  private isCurrentPrompt(sessionId: string, generation: number): boolean {
    return !this.stopped && this.promptGenerations.get(sessionId) === generation;
  }

  private isLatestPrompt(sessionId: string, generation: number): boolean {
    return (
      this.isCurrentPrompt(sessionId, generation) &&
      this.isLatestPromptRequest(sessionId, generation)
    );
  }

  private isLatestPromptRequest(sessionId: string, generation: number): boolean {
    return this.promptRequestGenerations.get(sessionId) === generation;
  }

  private reservePromptRequest(sessionId: string): number {
    const generation =
      Math.max(
        this.promptRequestGenerations.get(sessionId) ?? 0,
        this.promptGenerations.get(sessionId) ?? 0,
      ) + 1;
    this.promptRequestGenerations.set(sessionId, generation);
    return generation;
  }

  private commitReservedGeneration(sessionId: string, generation: number): void {
    if (this.promptRequestGenerations.get(sessionId) === generation) {
      this.promptGenerations.set(sessionId, generation);
    }
  }
}
