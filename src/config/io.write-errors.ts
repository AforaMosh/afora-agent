// Formats stable user-facing config write failures.
import type { ConfigWriteRejection } from "./io.write-plan.js";
const OPEN_DM_POLICY_ALLOW_FROM_RE =
  /^(?<policyPath>[a-z0-9_.-]+)\s*=\s*"open"\s+requires\s+(?<allowPath>[a-z0-9_.-]+)(?:\s+\(or\s+[a-z0-9_.-]+\))?\s+to include "\*"$/i;

export function formatConfigValidationFailure(pathLabel: string, issueMessage: string): string {
  const match = issueMessage.match(OPEN_DM_POLICY_ALLOW_FROM_RE);
  const policyPath = match?.groups?.policyPath?.trim();
  const allowPath = match?.groups?.allowPath?.trim();
  if (!policyPath || !allowPath) {
    return `Config validation failed: ${pathLabel}: ${issueMessage}`;
  }

  return [
    `Config validation failed: ${pathLabel}`,
    "",
    `Configuration mismatch: ${policyPath} is "open", but ${allowPath} does not include "*".`,
    "",
    "Fix with:",
    `  openclaw config set ${allowPath} '["*"]'`,
    "",
    "Or switch policy:",
    `  openclaw config set ${policyPath} "pairing"`,
  ].join("\n");
}

export function formatConfigWriteRejection(rejection: ConfigWriteRejection): string {
  if (rejection.code === "blocked-key") {
    return `Config write contains a blocked object key at ${rejection.path.join(".") || "<root>"}.`;
  }
  if (rejection.code === "implicit-agent-removal") {
    return `Config write would drop agent roster entries without an explicit deletion: ${rejection.agentIds.join(", ")}.`;
  }
  const pathLabel = rejection.path.length > 0 ? rejection.path.join(".") : "<root>";
  if (rejection.filePaths && rejection.filePaths.length > 1) {
    return (
      `Config write cannot update $include-owned config at ${pathLabel}; contributing include files: ${rejection.filePaths.join(", ")}. ` +
      "Edit the winning include file or remove the $include, then run `openclaw doctor --fix` before retrying."
    );
  }
  return (
    `Config write cannot update $include-owned config at ${pathLabel} from ${rejection.filePath}; ` +
    "edit that include file directly or remove the $include, then run `openclaw doctor --fix` before retrying."
  );
}
