/** Shared ACP permission helpers for process-local approval hosts. */
import type { PermissionOption, RequestPermissionResponse } from "@agentclientprotocol/sdk";

export type AcpApprovalDecision = "allow-once" | "allow-always" | "deny";

function normalizeAcpApprovalDecision(value: unknown): AcpApprovalDecision | undefined {
  if (value === "allow-once" || value === "allow-always" || value === "deny") {
    return value;
  }
  return undefined;
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
