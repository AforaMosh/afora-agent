import { randomUUID } from "node:crypto";
import type {
  AgentSideConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type {
  AgentRunApprovalHost,
  AgentRunExecApprovalHost,
  AgentRunExecApprovalLease,
  AgentRunExecApprovalRequest,
  AgentRunPluginApprovalHost,
  AgentRunPluginApprovalResult,
} from "../agents/agent-run-approval.js";
import { toErrorObject } from "../infra/errors.js";
import { resolveExecApprovalRequestAllowedDecisions } from "../infra/exec-approvals-policy.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import {
  buildAcpPermissionOptions,
  resolveAcpApprovalDecision,
  type AcpApprovalDecision,
} from "./permission-relay.js";

type PermissionRequestResult =
  | { kind: "response"; response: RequestPermissionResponse }
  | { kind: "timeout" }
  | { kind: "aborted"; reason: unknown }
  | { kind: "error" };

type ExecApprovalSettlement =
  | { kind: "decision"; decision: AcpApprovalDecision }
  | { kind: "aborted"; reason: unknown };

function resolveTimeoutMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function resolveAbortReason(signal: AbortSignal, fallback: string): Error {
  return toErrorObject(signal.reason, fallback);
}

function buildExecPermissionRequest(params: {
  sessionId: string;
  request: AgentRunExecApprovalRequest;
}): RequestPermissionRequest {
  const request = params.request;
  // A prepared system run plan is the execution authority for node-hosted commands.
  // Never mix its argv/cwd with the outer request's earlier command representation.
  const command = request.systemRunPlan
    ? (request.systemRunPlan.commandPreview ?? request.systemRunPlan.commandText)
    : (request.command ?? request.commandArgv?.join(" "));
  const commandArgv = request.systemRunPlan?.argv ?? request.commandArgv;
  const cwd = request.systemRunPlan ? request.systemRunPlan.cwd : request.cwd;
  const rawInput: Record<string, unknown> = {
    name: "exec",
    approvalId: request.id,
    host: request.host,
    security: request.security,
    ask: request.ask,
  };
  if (command) {
    rawInput.command = command;
  }
  if (commandArgv?.length) {
    rawInput.commandArgv = commandArgv;
  }
  if (cwd) {
    rawInput.cwd = cwd;
  }
  if (request.nodeId) {
    rawInput.nodeId = request.nodeId;
  }
  if (request.warningText) {
    rawInput.warningText = request.warningText;
  }
  const envKeys = request.env ? Object.keys(request.env).toSorted() : [];
  if (envKeys.length > 0) {
    rawInput.envKeys = envKeys;
  }
  return {
    sessionId: params.sessionId,
    toolCall: {
      toolCallId: request.toolCallId ?? `exec:${request.id}`,
      title: "Command approval requested",
      kind: "execute",
      status: "pending",
      rawInput,
      _meta: {
        toolName: "exec",
        approvalId: request.id,
      },
    },
    options: buildAcpPermissionOptions(resolveExecApprovalRequestAllowedDecisions(request)),
  };
}

function buildPluginPermissionRequest(params: {
  sessionId: string;
  approvalId: string;
  request: PluginApprovalRequestPayload;
}): RequestPermissionRequest {
  const request = params.request;
  const toolName = request.toolName ?? request.pluginId ?? "plugin";
  const rawInput: Record<string, unknown> = {
    name: toolName,
    approvalId: params.approvalId,
    title: request.title,
    description: request.description,
  };
  if (request.pluginId) {
    rawInput.pluginId = request.pluginId;
  }
  if (request.detail) {
    rawInput.detail = request.detail;
  }
  if (request.severity) {
    rawInput.severity = request.severity;
  }
  return {
    sessionId: params.sessionId,
    toolCall: {
      toolCallId: request.toolCallId ?? params.approvalId,
      title: request.title,
      kind: "other",
      status: "pending",
      rawInput,
      _meta: {
        toolName,
        approvalId: params.approvalId,
        ...(request.pluginId ? { pluginId: request.pluginId } : {}),
      },
    },
    options: buildAcpPermissionOptions(
      resolveCanonicalPluginApprovalRequestAllowedDecisions(request),
    ),
  };
}

async function requestPermissionWithDeadline(params: {
  connection: AgentSideConnection;
  request: RequestPermissionRequest;
  expiresAtMs: number;
  signal?: AbortSignal;
}): Promise<PermissionRequestResult> {
  if (params.signal?.aborted) {
    return {
      kind: "aborted",
      reason: resolveAbortReason(params.signal, "ACP permission request aborted"),
    };
  }
  const remainingTimeoutMs = params.expiresAtMs - Date.now();
  if (remainingTimeoutMs <= 0) {
    return { kind: "timeout" };
  }

  return new Promise<PermissionRequestResult>((resolve) => {
    let settled = false;
    const finish = (result: PermissionRequestResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      if (!params.signal) {
        return;
      }
      finish({
        kind: "aborted",
        reason: resolveAbortReason(params.signal, "ACP permission request aborted"),
      });
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), remainingTimeoutMs);
    timer.unref?.();
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) {
      onAbort();
      return;
    }
    if (Date.now() >= params.expiresAtMs) {
      finish({ kind: "timeout" });
      return;
    }
    let permissionRequest: Promise<RequestPermissionResponse>;
    try {
      permissionRequest = params.connection.requestPermission(params.request);
    } catch {
      finish(Date.now() >= params.expiresAtMs ? { kind: "timeout" } : { kind: "error" });
      return;
    }
    void permissionRequest.then(
      (response) =>
        finish(
          Date.now() >= params.expiresAtMs ? { kind: "timeout" } : { kind: "response", response },
        ),
      () => finish(Date.now() >= params.expiresAtMs ? { kind: "timeout" } : { kind: "error" }),
    );
  });
}

function createExecApprovalLease(params: {
  connection: AgentSideConnection;
  sessionId: string;
  request: AgentRunExecApprovalRequest;
  timeoutMs: number;
  signal?: AbortSignal;
}): AgentRunExecApprovalLease {
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  const expiresAtMs = Date.now() + timeoutMs;
  const permissionRequestPayload = buildExecPermissionRequest({
    sessionId: params.sessionId,
    request: params.request,
  });
  const autoReviewDecision = permissionRequestPayload.options.some(
    (option) => option.optionId === "allow-once",
  )
    ? "allow-once"
    : "deny";
  let settled = false;
  let permissionRequestStarted = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveSettlement!: (settlement: ExecApprovalSettlement) => void;
  const settlement = new Promise<ExecApprovalSettlement>((resolve) => {
    resolveSettlement = resolve;
  });
  const finish = (result: ExecApprovalSettlement) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timeout) {
      clearTimeout(timeout);
    }
    params.signal?.removeEventListener("abort", onRequestAbort);
    resolveSettlement(result);
  };
  const finishDecision = (decision: AcpApprovalDecision) => {
    finish({
      kind: "decision",
      decision: decision !== "deny" && Date.now() >= expiresAtMs ? "deny" : decision,
    });
  };
  const onRequestAbort = () => {
    if (!params.signal) {
      return;
    }
    finish({
      kind: "aborted",
      reason: resolveAbortReason(params.signal, "ACP exec approval request aborted"),
    });
  };
  if (timeoutMs <= 0) {
    finishDecision("deny");
  } else {
    timeout = setTimeout(() => finishDecision("deny"), timeoutMs);
    timeout.unref?.();
  }
  params.signal?.addEventListener("abort", onRequestAbort, { once: true });
  if (params.signal?.aborted) {
    onRequestAbort();
  }

  const startPermissionRequest = () => {
    if (settled || permissionRequestStarted) {
      return;
    }
    permissionRequestStarted = true;
    if (params.signal?.aborted) {
      onRequestAbort();
      return;
    }
    if (Date.now() >= expiresAtMs) {
      finishDecision("deny");
      return;
    }
    if (permissionRequestPayload.options.length === 0) {
      finishDecision("deny");
      return;
    }
    let requestPromise: Promise<RequestPermissionResponse>;
    try {
      requestPromise = params.connection.requestPermission(permissionRequestPayload);
    } catch {
      finishDecision("deny");
      return;
    }
    void requestPromise.then(
      (response) =>
        finishDecision(
          resolveAcpApprovalDecision(response, permissionRequestPayload.options) ?? "deny",
        ),
      () => finishDecision("deny"),
    );
  };

  return Object.freeze({
    id: params.request.id,
    expiresAtMs,
    wait: async (waitParams) => {
      const waitSignal = waitParams?.signal;
      if (waitSignal?.aborted) {
        throw resolveAbortReason(waitSignal, "ACP exec approval wait aborted");
      }
      const waitForSettlement = async () => {
        const result = await settlement;
        if (result.kind === "aborted") {
          throw result.reason;
        }
        return result.decision;
      };
      if (!waitSignal) {
        startPermissionRequest();
        return await waitForSettlement();
      }
      return await new Promise<AcpApprovalDecision>((resolve, reject) => {
        const onWaitAbort = () => {
          reject(resolveAbortReason(waitSignal, "ACP exec approval wait aborted"));
        };
        waitSignal.addEventListener("abort", onWaitAbort, { once: true });
        if (waitSignal.aborted) {
          onWaitAbort();
          return;
        }
        startPermissionRequest();
        void waitForSettlement()
          .then(resolve, reject)
          .finally(() => {
            waitSignal.removeEventListener("abort", onWaitAbort);
          });
      });
    },
    resolveAutoReview: async () => {
      finishDecision(autoReviewDecision);
    },
    cancel: async () => {
      finishDecision("deny");
    },
  });
}

async function requestPluginApproval(params: {
  connection: AgentSideConnection;
  sessionId: string;
  request: PluginApprovalRequestPayload;
  timeoutMs: number;
  signal?: AbortSignal;
  onRegistered?: (registration: { id: string }) => void;
}): Promise<AgentRunPluginApprovalResult> {
  params.signal?.throwIfAborted();
  const expiresAtMs = Date.now() + resolveTimeoutMs(params.timeoutMs);
  const approvalId = `plugin:${randomUUID()}`;
  params.onRegistered?.({ id: approvalId });
  params.signal?.throwIfAborted();
  const request = buildPluginPermissionRequest({
    sessionId: params.sessionId,
    approvalId,
    request: params.request,
  });
  if (request.options.length === 0) {
    return { outcome: "resolved", decision: "deny" };
  }
  const result = await requestPermissionWithDeadline({
    connection: params.connection,
    request,
    expiresAtMs,
    signal: params.signal,
  });
  if (result.kind === "aborted") {
    throw result.reason;
  }
  if (result.kind === "timeout") {
    return { outcome: "timed-out" };
  }
  if (result.kind === "error") {
    return {
      outcome: "unavailable",
      reason: "ACP permission request failed.",
    };
  }
  return {
    outcome: "resolved",
    decision: resolveAcpApprovalDecision(result.response, request.options) ?? "deny",
  };
}

type AcpApprovalHostOptions = {
  connection: AgentSideConnection;
  sessionId: string;
};

/** Binds one ACP client connection and session to process-local run approvals. */
export function createAcpApprovalHost(options: AcpApprovalHostOptions): AgentRunApprovalHost {
  return Object.freeze({
    exec: Object.freeze<AgentRunExecApprovalHost>({
      request: async ({ request, timeoutMs, signal }) => {
        signal?.throwIfAborted();
        return createExecApprovalLease({
          connection: options.connection,
          sessionId: options.sessionId,
          request,
          timeoutMs,
          signal,
        });
      },
    }),
    plugin: Object.freeze<AgentRunPluginApprovalHost>({
      request: ({ request, timeoutMs, signal, onRegistered }) =>
        requestPluginApproval({
          connection: options.connection,
          sessionId: options.sessionId,
          request,
          timeoutMs,
          signal,
          onRegistered,
        }),
    }),
  });
}
