/** Shared ACP permission helpers plus the legacy Gateway approval relay. */
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { normalizeOptionalString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";

export type AcpApprovalDecision = "allow-once" | "allow-always" | "deny";
export type GatewayExecApprovalDecision = AcpApprovalDecision;

export type GatewayExecApprovalEvent = {
  approvalId: string;
  command?: string;
  host?: string;
  title?: string;
  toolCallId?: string;
};

export type GatewayExecApprovalDetails = {
  allowedDecisions?: unknown;
  commandPreview?: unknown;
  commandText?: unknown;
  host?: unknown;
};

const FALLBACK_EXEC_APPROVAL_DECISIONS = ["allow-once", "deny"] as const;

function normalizeAcpApprovalDecision(value: unknown): AcpApprovalDecision | undefined {
  if (value === "allow-once" || value === "allow-always" || value === "deny") {
    return value;
  }
  return undefined;
}

/** Normalizes allowed Gateway exec approval decisions with a conservative fallback set. */
function normalizeGatewayExecApprovalDecisions(value: unknown): GatewayExecApprovalDecision[] {
  const normalized = Array.isArray(value)
    ? value
        .map(normalizeAcpApprovalDecision)
        .filter((decision): decision is GatewayExecApprovalDecision => Boolean(decision))
    : [];
  return normalized.length > 0 ? normalized : [...FALLBACK_EXEC_APPROVAL_DECISIONS];
}

/** Converts OpenClaw approval decisions into ACP permission options. */
export function buildAcpPermissionOptions(
  decisions: readonly AcpApprovalDecision[],
): PermissionOption[] {
  const unique = new Set<AcpApprovalDecision>(decisions);
  const options: PermissionOption[] = [];
  if (unique.has("allow-once")) {
    options.push({
      optionId: "allow-once",
      name: "Allow once",
      kind: "allow_once",
    });
  }
  if (unique.has("allow-always")) {
    options.push({
      optionId: "allow-always",
      name: "Allow always",
      kind: "allow_always",
    });
  }
  if (unique.has("deny")) {
    options.push({
      optionId: "deny",
      name: "Deny",
      kind: "reject_once",
    });
  }
  return options;
}

/** Maps a selected ACP option back to an approval decision only when it was offered. */
export function resolveAcpApprovalDecision(
  response: RequestPermissionResponse | undefined,
  options: readonly PermissionOption[],
): AcpApprovalDecision | undefined {
  const outcome = response?.outcome;
  if (!outcome || outcome.outcome !== "selected") {
    return undefined;
  }
  const selected = options.find((option) => option.optionId === outcome.optionId);
  return normalizeAcpApprovalDecision(selected?.optionId);
}

/** Parses legacy Gateway approval event data into ACP relay state. */
export function parseGatewayExecApprovalEventData(
  data: Record<string, unknown>,
): GatewayExecApprovalEvent | null {
  if (data.phase !== "requested" || data.kind !== "exec" || data.status !== "pending") {
    return null;
  }
  const approvalId = readNonEmptyString(data.approvalId);
  if (!approvalId) {
    return null;
  }
  return {
    approvalId,
    command: readNonEmptyString(data.command),
    host: readNonEmptyString(data.host),
    title: readNonEmptyString(data.title),
    toolCallId: readNonEmptyString(data.toolCallId),
  };
}

/** Parses structured Gateway approval-request payloads into ACP relay state. */
export function parseGatewayExecApprovalRequestEventPayload(
  payload: Record<string, unknown>,
): GatewayExecApprovalEvent | null {
  const approvalId = readNonEmptyString(payload.id);
  const request = payload.request;
  if (!approvalId || !request || typeof request !== "object" || Array.isArray(request)) {
    return null;
  }
  const requestRecord = request as Record<string, unknown>;
  return {
    approvalId,
    command:
      readNonEmptyString(requestRecord.command) ?? readNonEmptyString(requestRecord.commandPreview),
    host: readNonEmptyString(requestRecord.host),
    toolCallId: readNonEmptyString(requestRecord.toolCallId),
  };
}

/** Builds the ACP request_permission payload shown to a client. */
export function buildAcpPermissionRequest(params: {
  sessionId: string;
  event: GatewayExecApprovalEvent;
  details?: GatewayExecApprovalDetails | null;
}): RequestPermissionRequest {
  const command =
    readNonEmptyString(params.details?.commandText) ??
    readNonEmptyString(params.details?.commandPreview) ??
    params.event.command;
  const host = readNonEmptyString(params.details?.host) ?? params.event.host;
  const decisions = normalizeGatewayExecApprovalDecisions(params.details?.allowedDecisions);
  const rawInput: Record<string, string> = {
    name: "exec",
    approvalId: params.event.approvalId,
  };
  if (command) {
    rawInput.command = command;
  }
  if (host) {
    rawInput.host = host;
  }

  return {
    sessionId: params.sessionId,
    toolCall: {
      // Raw approval events can arrive before Gateway emits a tool call id; the
      // approval id remains the stable correlation key for those early prompts.
      toolCallId: params.event.toolCallId ?? `exec:${params.event.approvalId}`,
      title: params.event.title ?? "Command approval requested",
      kind: "execute",
      status: "pending",
      rawInput,
      _meta: {
        toolName: "exec",
        approvalId: params.event.approvalId,
      },
    },
    options: buildAcpPermissionOptions(decisions),
  };
}

/** Maps an ACP permission response back to the Gateway exec approval decision. */
export function resolveGatewayDecisionFromPermissionOutcome(
  response: RequestPermissionResponse | undefined,
  options: readonly PermissionOption[],
): GatewayExecApprovalDecision | undefined {
  return resolveAcpApprovalDecision(response, options);
}
