import { AgentHarnessPreflightError } from "afora-agent/plugin-sdk/agent-harness-runtime";
import { resolveAgentConfig } from "afora-agent/plugin-sdk/agent-scope-runtime";
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import {
  resolveExecApprovalsFromFile,
  type ExecApprovalsFile,
} from "afora-agent/plugin-sdk/exec-approvals-runtime";
import type {
  CodexAppServerApprovalPolicy,
  CodexAppServerApprovalsReviewer,
  CodexAppServerDefaultPolicy,
  CodexAppServerPolicyMode,
  CodexAppServerSandboxMode,
  AforaExecApprovalFloorsForCodexAppServer,
  AforaExecAsk,
  AforaExecMode,
  AforaExecPolicy,
  AforaExecPolicyForCodexAppServer,
  AforaExecSecurity,
} from "./config-contracts.js";
import { readExecAsk, readExecSecurity, readRecord } from "./config-utils.js";

export function selectForcedPromptingSandbox(params: {
  configuredSandbox?: CodexAppServerSandboxMode;
  defaultSandbox?: CodexAppServerSandboxMode;
}): CodexAppServerSandboxMode {
  if (params.configuredSandbox === "read-only" || params.defaultSandbox === "read-only") {
    return "read-only";
  }
  return params.defaultSandbox ?? "workspace-write";
}

export function selectForcedDangerFullAccessSandbox(params: {
  configuredSandbox?: CodexAppServerSandboxMode;
  defaultPolicy: CodexAppServerDefaultPolicy | undefined;
  aforaSandboxActive: boolean;
}): CodexAppServerSandboxMode {
  if (params.configuredSandbox === "read-only") {
    return "read-only";
  }
  if (params.defaultPolicy?.dangerFullAccessAllowed === false) {
    if (params.aforaSandboxActive) {
      return params.defaultPolicy.sandbox ?? "workspace-write";
    }
    throw new Error(
      "legacy full exec security with ask requires Codex app-server danger-full-access",
    );
  }
  return "danger-full-access";
}

export function selectGuardianSandbox(
  allowedSandboxModes: Set<CodexAppServerSandboxMode> | undefined,
): CodexAppServerSandboxMode {
  if (allowedSandboxModes === undefined || allowedSandboxModes.has("workspace-write")) {
    return "workspace-write";
  }
  if (allowedSandboxModes.has("read-only")) {
    return "read-only";
  }
  if (allowedSandboxModes.has("danger-full-access")) {
    return "danger-full-access";
  }
  return "workspace-write";
}

export function resolveApprovalPolicy(value: unknown): CodexAppServerApprovalPolicy | undefined {
  if (value === "on-failure") {
    return "on-request";
  }
  return value === "on-request" || value === "untrusted" || value === "never" ? value : undefined;
}

export function resolveSandbox(value: unknown): CodexAppServerSandboxMode | undefined {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
    ? value
    : undefined;
}

export function resolveApprovalsReviewer(
  value: unknown,
): CodexAppServerApprovalsReviewer | undefined {
  return value === "auto_review" || value === "guardian_subagent" || value === "user"
    ? value
    : undefined;
}

function resolveAforaExecPolicyFromConfig(params: {
  config?: AforaConfig;
  agentId?: string;
}): AforaExecPolicy {
  const globalExec = readRecord(params.config?.tools?.exec);
  const globalPolicy = applyAforaExecPolicyLayer(createDefaultAforaExecPolicy(), globalExec);
  const agentId = params.agentId?.trim();
  const agentExec = agentId
    ? readRecord(resolveAgentConfig(params.config ?? {}, agentId)?.tools?.exec)
    : undefined;
  return applyAforaExecPolicyLayer(globalPolicy, agentExec);
}

export function resolveAforaExecPolicyForCodexAppServer(params: {
  execOverrides?: {
    mode?: unknown;
    security?: unknown;
    ask?: unknown;
  };
  approvals?: ExecApprovalsFile;
  config?: AforaConfig;
  agentId?: string;
}): AforaExecPolicyForCodexAppServer {
  const basePolicy = resolveAforaExecPolicyFromConfig({
    config: params.config,
    agentId: params.agentId,
  });
  const overridePolicy = applyAforaExecPolicyLayer(basePolicy, params.execOverrides);
  const approvalFloors = resolveAforaExecApprovalFloorsForCodexAppServer({
    approvals: params.approvals,
    agentId: params.agentId,
    policy: overridePolicy,
  });
  return applyAforaExecApprovalFloors(overridePolicy, approvalFloors);
}

export function resolveEffectiveAforaExecModeForCodexAppServer(params: {
  execMode?: AforaExecMode;
  execPolicy?: AforaExecPolicyForCodexAppServer;
}): AforaExecMode | undefined {
  if (params.execPolicy?.touched === true) {
    return params.execPolicy.mode;
  }
  return params.execMode;
}

export function resolveCodexPolicyModeForAforaExecMode(
  mode: AforaExecMode | undefined,
): CodexAppServerPolicyMode | undefined {
  if (!mode || mode === "full") {
    return undefined;
  }
  return "guardian";
}

export function assertCodexAppServerAllowedForAforaExecMode(
  mode: AforaExecMode | undefined,
): void {
  if (mode === "deny" || mode === "allowlist") {
    throw new AgentHarnessPreflightError(
      `Codex app-server local execution is unavailable because effective tools.exec.mode=${mode}. ` +
        "Execution-host approvals are authoritative. For gateway turns, inspect them with `afora approvals get --gateway` and update that same target with `afora approvals set --gateway --stdin`; for local `agent exec`, omit `--gateway`. Intentionally align that host policy before retrying.",
      { scope: "harness" },
    );
  }
}

function createDefaultAforaExecPolicy(): AforaExecPolicy {
  return {
    ...resolveAforaExecPolicyForMode("full"),
    touched: false,
  };
}

function applyAforaExecPolicyLayer(
  base: AforaExecPolicy,
  exec?: { mode?: unknown; security?: unknown; ask?: unknown },
): AforaExecPolicy {
  if (!exec) {
    return base;
  }
  const mode = readExecMode(exec.mode);
  if (mode !== undefined) {
    return {
      ...resolveAforaExecPolicyForMode(mode),
      touched: true,
    };
  }
  const security = readExecSecurity(exec.security);
  const ask = readExecAsk(exec.ask);
  if (security === undefined && ask === undefined) {
    return base;
  }
  const nextSecurity = security ?? base.security;
  const nextAsk = ask ?? base.ask;
  return {
    mode: resolveAforaExecModeFromPolicy({ security: nextSecurity, ask: nextAsk }),
    security: nextSecurity,
    ask: nextAsk,
    touched: true,
  };
}

function resolveAforaExecApprovalFloorsForCodexAppServer(params: {
  approvals?: ExecApprovalsFile;
  agentId?: string;
  policy: AforaExecPolicy;
}): AforaExecApprovalFloorsForCodexAppServer | undefined {
  if (!params.approvals) {
    return undefined;
  }
  return resolveExecApprovalsFromFile({
    file: params.approvals,
    agentId: params.agentId,
    overrides: {
      security: params.policy.security,
      ask: params.policy.ask,
    },
  }).agent;
}

function applyAforaExecApprovalFloors(
  base: AforaExecPolicy,
  approvalFloors?: AforaExecApprovalFloorsForCodexAppServer,
): AforaExecPolicy {
  if (!approvalFloors) {
    return base;
  }
  const nextSecurity = approvalFloors.security
    ? minAforaExecSecurity(base.security, approvalFloors.security)
    : base.security;
  const nextAsk = approvalFloors.ask ? maxAforaExecAsk(base.ask, approvalFloors.ask) : base.ask;
  if (nextSecurity === base.security && nextAsk === base.ask) {
    return base;
  }
  return {
    mode: resolveAforaExecModeFromPolicy({ security: nextSecurity, ask: nextAsk }),
    security: nextSecurity,
    ask: nextAsk,
    touched: true,
  };
}

function resolveAforaExecPolicyForMode(
  mode: AforaExecMode,
): Omit<AforaExecPolicy, "touched"> {
  switch (mode) {
    case "deny":
      return { mode, security: "deny", ask: "off" };
    case "allowlist":
      return { mode, security: "allowlist", ask: "off" };
    case "ask":
    case "auto":
      return { mode, security: "allowlist", ask: "on-miss" };
    case "full":
      return { mode, security: "full", ask: "off" };
  }
  const exhaustiveMode: never = mode;
  return exhaustiveMode;
}

function resolveAforaExecModeFromPolicy(params: {
  security: AforaExecSecurity;
  ask: AforaExecAsk;
}): AforaExecMode {
  if (params.security === "deny") {
    return "deny";
  }
  if (params.security === "allowlist" && params.ask === "off") {
    return "allowlist";
  }
  if (params.security === "full" && params.ask !== "always") {
    return "full";
  }
  return "ask";
}

function minAforaExecSecurity(
  left: AforaExecSecurity,
  right: AforaExecSecurity,
): AforaExecSecurity {
  const order: Record<AforaExecSecurity, number> = { deny: 0, allowlist: 1, full: 2 };
  return order[left] <= order[right] ? left : right;
}

function maxAforaExecAsk(left: AforaExecAsk, right: AforaExecAsk): AforaExecAsk {
  const order: Record<AforaExecAsk, number> = { off: 0, "on-miss": 1, always: 2 };
  return order[left] >= order[right] ? left : right;
}

function readExecMode(value: unknown): AforaExecMode | undefined {
  return value === "deny" ||
    value === "allowlist" ||
    value === "ask" ||
    value === "auto" ||
    value === "full"
    ? value
    : undefined;
}
