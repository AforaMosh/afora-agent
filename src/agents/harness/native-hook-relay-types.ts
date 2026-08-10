import type { Server } from "node:http";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginHookToolRequesterContext } from "../../plugins/hook-types.js";
import type {
  BeforeToolCallFailureDisposition,
  DeferredPluginToolApproval,
  HookContext,
} from "../agent-tools.before-tool-call.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import type { NativeHookRelayBridgeRecordOwner } from "./native-hook-relay-store.js";

type NativeHookRelayApprovalContext = Pick<
  HookContext,
  | "approvalReviewerDeviceId"
  | "trigger"
  | "turnSourceAccountId"
  | "turnSourceChannel"
  | "turnSourceThreadId"
  | "turnSourceTo"
>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const NATIVE_HOOK_RELAY_EVENTS = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
] as const;

const NATIVE_HOOK_RELAY_PROVIDERS = ["codex"] as const;

export type NativeHookRelayEvent = (typeof NATIVE_HOOK_RELAY_EVENTS)[number];
export type NativeHookRelayProvider = (typeof NATIVE_HOOK_RELAY_PROVIDERS)[number];

export type NativeHookRelayInvocation = {
  provider: NativeHookRelayProvider;
  relayId: string;
  event: NativeHookRelayEvent;
  nativeEventName?: string;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  cwd?: string;
  model?: string;
  turnId?: string;
  transcriptPath?: string;
  permissionMode?: string;
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
  toolName?: string;
  toolUseId?: string;
  rawPayload: JsonValue;
  receivedAt: string;
};

export type NativeHookRelayProcessResponse = {
  stdout: string;
  stderr: string;
  exitCode: number;
  failureDisposition?: Exclude<BeforeToolCallFailureDisposition, "blocked">;
};

export type NativeHookRelayRegistration = {
  relayId: string;
  provider: NativeHookRelayProvider;
  generationMismatchGraceExpiresAtMs?: number;
  generationMismatchGraceAcceptedGeneration?: string;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  runId: string;
  channelId?: string;
  requester?: PluginHookToolRequesterContext;
  approvalContext?: NativeHookRelayApprovalContext;
  allowedEvents: readonly NativeHookRelayEvent[];
  expiresAtMs: number;
  signal?: AbortSignal;
  /** Exact host policy capability for authority-bearing native callbacks. */
  runBeforeToolCall?: AgentHarnessHostCapabilities["runBeforeToolCall"];
  /** Revalidates the exact admitted owner after authority-bearing awaits. */
  assertActive?: AgentHarnessHostCapabilities["assertActive"];
  onPreToolUseFailure?: (failure: {
    toolName: string;
    toolCallId: string;
    disposition: Exclude<BeforeToolCallFailureDisposition, "blocked">;
    durationMs: number;
  }) => void | Promise<void>;
};

export type NativeHookRelayAttemptBinding = Pick<
  RegisterNativeHookRelayParams,
  | "runId"
  | "config"
  | "channelId"
  | "requester"
  | "approvalContext"
  | "preToolUseLoopDetection"
  | "signal"
  | "runBeforeToolCall"
  | "assertActive"
  | "onPreToolUseFailure"
>;

export type NativeHookRelayInvocationBinding = Readonly<NativeHookRelayRegistration>;

export type NativeHookRelayRenewalStatus = "live" | "dead" | "foreign-owner" | "unknown";

export type NativeHookRelayRegistrationHandle = NativeHookRelayRegistration & {
  generation?: string;
  shouldRelayEvent: (event: NativeHookRelayEvent) => boolean;
  toolMatcherForEvent: (event: NativeHookRelayEvent) => readonly string[] | undefined;
  commandForEvent: (
    event: NativeHookRelayEvent,
    options?: NativeHookRelayCommandForEventOptions,
  ) => string;
  renew: (ttlMs?: number) => void;
  /** Reports authoritative liveness when the relay implementation supports it. */
  renewStatus?: (ttlMs?: number) => NativeHookRelayRenewalStatus;
  rebindAttempt?: (binding: NativeHookRelayAttemptBinding) => boolean;
  unregister: () => void;
};

export type RegisterNativeHookRelayParams = {
  provider: NativeHookRelayProvider;
  relayId?: string;
  generation?: string;
  generationMismatchGraceMs?: number;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  runId: string;
  channelId?: string;
  requester?: PluginHookToolRequesterContext;
  approvalContext?: NativeHookRelayApprovalContext;
  allowedEvents?: readonly NativeHookRelayEvent[];
  /** Whether this relay should run OpenClaw loop detection from native PreToolUse hooks. */
  preToolUseLoopDetection?: boolean;
  ttlMs?: number;
  command?: NativeHookRelayCommandOptions;
  signal?: AbortSignal;
  runBeforeToolCall?: NativeHookRelayRegistration["runBeforeToolCall"];
  assertActive?: NativeHookRelayRegistration["assertActive"];
  onPreToolUseFailure?: NativeHookRelayRegistration["onPreToolUseFailure"];
};

type NativeHookRelayCommandOptions = {
  executable?: string;
  nice?: number | false;
  nodeExecutable?: string;
  timeoutMs?: number;
};

type NativeHookRelayCommandForEventOptions = {
  timeoutMs?: number;
};

export type InvokeNativeHookRelayParams = {
  provider: unknown;
  relayId: unknown;
  generation?: unknown;
  event: unknown;
  rawPayload: unknown;
  requireGeneration?: boolean;
};

export type InvokeNativeHookRelayBridgeParams = InvokeNativeHookRelayParams & {
  registrationTimeoutMs?: number;
  stateDbPath?: string;
  timeoutMs?: number;
};

export type NativeHookRelayInvocationMetadata = Partial<
  Pick<
    NativeHookRelayInvocation,
    | "nativeEventName"
    | "cwd"
    | "model"
    | "turnId"
    | "transcriptPath"
    | "permissionMode"
    | "stopHookActive"
    | "lastAssistantMessage"
    | "toolName"
    | "toolUseId"
  >
>;

type NativeHookRelayPermissionDecision = "allow" | "deny";

export type NativeHookRelayProviderAdapter = {
  normalizeMetadata: (rawPayload: JsonValue) => NativeHookRelayInvocationMetadata;
  readToolInput: (rawPayload: JsonValue) => Record<string, JsonValue>;
  readToolResponse: (rawPayload: JsonValue) => unknown;
  renderNoopResponse: (event: NativeHookRelayEvent) => NativeHookRelayProcessResponse;
  renderPreToolUseBlockResponse: (
    reason: string,
    failureDisposition?: Exclude<BeforeToolCallFailureDisposition, "blocked">,
  ) => NativeHookRelayProcessResponse;
  renderBeforeAgentFinalizeReviseResponse: (reason: string) => NativeHookRelayProcessResponse;
  renderBeforeAgentFinalizeStopResponse: (reason?: string) => NativeHookRelayProcessResponse;
  renderPermissionDecisionResponse: (
    decision: NativeHookRelayPermissionDecision,
    message?: string,
  ) => NativeHookRelayProcessResponse;
};

export type NativeHookRelayPermissionApprovalResult =
  | NativeHookRelayPermissionDecision
  | "allow-always"
  | "defer";

export type ActiveNativeHookRelayRegistration = NativeHookRelayRegistration & {
  generation: string;
  preToolUseLoopDetection: boolean;
  preToolUseFailureProjections: Map<string, { promise: Promise<void>; settled: boolean }>;
};

export type ActiveNativeHookRelayRegistrationHandle = NativeHookRelayRegistrationHandle & {
  generation: string;
  renewStatus: (ttlMs?: number) => NativeHookRelayRenewalStatus;
};

export type NativeHookRelayPermissionApprovalRequest = {
  provider: NativeHookRelayProvider;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  toolName: string;
  toolCallId?: string;
  cwd?: string;
  model?: string;
  toolInput: Record<string, JsonValue>;
  signal?: AbortSignal;
};

export type NativeHookRelayPermissionApprovalRequester = (
  request: NativeHookRelayPermissionApprovalRequest,
) => Promise<NativeHookRelayPermissionApprovalResult>;

export type NativeHookRelayPreToolUseApproval = {
  deferredApproval: DeferredPluginToolApproval;
  originalParamsFingerprint: string;
  resolutionPromise?: Promise<NativeHookRelayDeferredApprovalOutcome>;
};

export type NativeHookRelayDeferredApprovalOutcome =
  | {
      handled: true;
      outcome: "approved-once";
    }
  | {
      handled: true;
      outcome: "denied";
      reason: string;
      failureDisposition?: Exclude<BeforeToolCallFailureDisposition, "blocked">;
    };

export type NativeHookRelayBridgeRegistration = {
  relayId: string;
  stateDbPath: string;
  token: string;
  server: Server;
  // SQLite ownership is synchronous; listener publication is asynchronous.
  // Keep both facts explicit so a claimed port-zero row is never called routable.
  ownershipStatus: NativeHookRelayBridgeOwnershipStatus;
  predecessor?: NativeHookRelayBridgeRecordOwner;
  listenerStatus: "idle" | "starting" | "listening" | "failed";
  // A void renew can outlive a transient store failure. Recovery must publish
  // its requested deadline rather than reviving the last committed lease.
  desiredExpiresAtMs: number;
  recoveryAttempt: number;
  recoveryTimer?: ReturnType<typeof setTimeout>;
};

type NativeHookRelayBridgeOwnershipStatus = "renewed" | "foreign-owner" | "unknown";

export type NativeHookRelaySharedState = {
  relays: Map<string, ActiveNativeHookRelayRegistration>;
  relayBridges: Map<string, NativeHookRelayBridgeRegistration>;
  invocations: NativeHookRelayInvocation[];
  pendingPermissionApprovals: Map<string, Promise<NativeHookRelayPermissionApprovalResult>>;
  pendingPreToolUseApprovals: Map<string, NativeHookRelayPreToolUseApproval>;
  permissionApprovalWindows: Map<string, number[]>;
  permissionAllowAlwaysApprovals: Map<string, { expiresAtMs: number }>;
};
