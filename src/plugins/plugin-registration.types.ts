import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Command } from "commander";
import type { AforaConfig } from "../config/types.afora.js";
import type {
  DiagnosticEventPrivateData,
  DiagnosticEventInput,
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import type { DiagnosticTracePropagationBridge as DiagnosticTracePropagationBridgeContract } from "../infra/diagnostic-trace-propagation.js";
import type { SecurityAuditFinding } from "../security/audit.types.js";
import type { PluginLogger } from "./logger-types.js";

type ChannelPlugin = import("../channels/plugins/types.plugin.js").ChannelPlugin;
type DiagnosticTracePropagationBridge = DiagnosticTracePropagationBridgeContract<
  DiagnosticEventPayload,
  DiagnosticEventMetadata
>;

type PluginInteractiveHandlerResult = {
  handled?: boolean;
} | void;

export type PluginInteractiveRegistration<
  TContext = unknown,
  TChannel extends string = string,
  TResult = PluginInteractiveHandlerResult,
> = {
  channel: TChannel;
  namespace: string;
  handler: (ctx: TContext) => Promise<TResult> | TResult;
};

export type PluginInteractiveHandlerRegistration = PluginInteractiveRegistration;

export type AforaPluginHttpRouteAuth = "gateway" | "plugin";
export type AforaPluginHttpRouteMatch = "exact" | "prefix";
export type AforaPluginGatewayRuntimeScopeSurface = "write-default" | "trusted-operator";

export type AforaPluginHttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean | void> | boolean | void;

export type AforaPluginHttpRouteUpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => Promise<boolean | void> | boolean | void;

export type AforaPluginHttpRouteParams = {
  path: string;
  handler: AforaPluginHttpRouteHandler;
  handleUpgrade?: AforaPluginHttpRouteUpgradeHandler;
  auth: AforaPluginHttpRouteAuth;
  match?: AforaPluginHttpRouteMatch;
  gatewayRuntimeScopeSurface?: AforaPluginGatewayRuntimeScopeSurface;
  nodeCapability?: {
    surface: string;
    ttlMs?: number;
  };
  replaceExisting?: boolean;
};

export type AforaPluginHostedMediaResolver = (
  mediaUrl: string,
) => string | null | undefined | Promise<string | null | undefined>;

export type AforaPluginCliContext = {
  /**
   * Command object where this plugin should register its commands.
   *
   * For root CLI registrations this is the root `afora` program. For nested
   * registrations it is the resolved parent command from `parentPath`.
   */
  program: Command;
  parentPath: readonly string[];
  config: AforaConfig;
  workspaceDir?: string;
  logger: PluginLogger;
};

export type AforaPluginCliRegistrar = (ctx: AforaPluginCliContext) => void | Promise<void>;

/**
 * Top-level CLI metadata for plugin-owned commands.
 *
 * Descriptors are the parse-time contract for lazy plugin CLI registration.
 * If you want Afora to keep a plugin command lazy-loaded while still
 * advertising it at the root CLI level, provide descriptors that cover every
 * top-level command root registered by that plugin CLI surface.
 */
type AforaPluginCliCommandDescriptor = {
  name: string;
  description: string;
  hasSubcommands: boolean;
};

/** Root-command metadata that is available before a plugin registrar is activated. */
export type AforaPluginCliRootCommandDescriptor = AforaPluginCliCommandDescriptor & {
  machineOutput?: (params: { argv: readonly string[]; stdoutIsTTY: boolean }) => boolean;
};

type AforaPluginRootCliRegistrationOptions = {
  /** Omit or pass an empty path for root commands. */
  parentPath?: readonly [];
  commands?: readonly string[];
  descriptors?: readonly AforaPluginCliRootCommandDescriptor[];
};

/** Backward-compatible registration shape for dynamic root or nested paths. */
type AforaPluginLegacyCliRegistrationOptions = {
  parentPath?: readonly string[];
  commands?: readonly string[];
  descriptors?: readonly AforaPluginCliCommandDescriptor[];
};

export type AforaPluginCliRegistrationOptions =
  | AforaPluginRootCliRegistrationOptions
  | AforaPluginLegacyCliRegistrationOptions;

export type AforaPluginNodeCliFeatureOptions = {
  /** Explicit node feature command names owned under `afora nodes`. */
  commands?: string[];
  /**
   * Parse-time command descriptors for lazy node feature CLI registration.
   *
   * Descriptors are registered under `afora nodes`, so a descriptor named
   * `"camera"` exposes `afora nodes camera`.
   */
  descriptors?: AforaPluginCliCommandDescriptor[];
};

export type AforaPluginReloadRegistration = {
  restartPrefixes?: string[];
  hotPrefixes?: string[];
  noopPrefixes?: string[];
};

export type {
  AforaPluginNodeHostCommand,
  AforaPluginNodeHostCommandAvailabilityContext,
  AforaPluginNodeHostCommandIo,
} from "./types.node-host.js";

export type AforaPluginNodeInvokeTransportResult =
  | {
      ok: true;
      payload?: unknown;
      payloadJSON?: string | null;
    }
  | {
      ok: false;
      code?: string;
      message: string;
      details?: Record<string, unknown>;
    };

type AforaPluginNodeInvokeApprovalDecision = "allow-once" | "allow-always" | "deny";

type AforaPluginNodeInvokePolicyApprovalRuntime = {
  request: (input: {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    toolName?: string;
    toolCallId?: string;
    agentId?: string;
    sessionKey?: string;
    timeoutMs?: number;
  }) => Promise<{
    id?: string;
    decision?: AforaPluginNodeInvokeApprovalDecision | null;
  }>;
};

export type AforaPluginNodeInvokePolicyContext = {
  nodeId: string;
  command: string;
  params: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
  config: AforaConfig;
  pluginConfig?: Record<string, unknown>;
  node?: {
    nodeId: string;
    displayName?: string;
    platform?: string;
    deviceFamily?: string;
    commands?: string[];
  };
  client?: {
    connId?: string;
    scopes?: string[];
  } | null;
  risk?: {
    level: "ordinary" | "high";
    /** Stable, content-free family name; never include user or action arguments. */
    family: string;
  };
  approvals?: AforaPluginNodeInvokePolicyApprovalRuntime;
  invokeNode: (input?: {
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
  }) => Promise<AforaPluginNodeInvokeTransportResult>;
};

export type AforaPluginNodeInvokePolicyResult =
  | {
      ok: true;
      payload?: unknown;
      payloadJSON?: string | null;
    }
  | {
      ok: false;
      message: string;
      code?: string;
      details?: Record<string, unknown>;
      unavailable?: boolean;
    };

export type AforaPluginNodeInvokePolicy = {
  commands: string[];
  /**
   * Platforms where these node-handled commands should be allowlisted by default.
   * Omit for commands that require explicit `gateway.nodes.commands.allow`.
   */
  defaultPlatforms?: Array<"ios" | "android" | "macos" | "windows" | "linux" | "unknown">;
  /**
   * Dangerous policy commands are filtered out of default allowlists unless
   * explicitly allowed by config.
   */
  dangerous?: boolean;
  /**
   * iOS foreground-restricted commands should be queued for foreground delivery
   * when an iOS node reports BACKGROUND_UNAVAILABLE.
   */
  foregroundRestrictedOnIos?: boolean;
  /**
   * Classify exact command arguments before the policy handler or node transport runs.
   * Throwing rejects the invocation before dispatch.
   */
  classifyRisk?: (
    ctx: Pick<AforaPluginNodeInvokePolicyContext, "command" | "params">,
  ) => NonNullable<AforaPluginNodeInvokePolicyContext["risk"]>;
  handle: (
    ctx: AforaPluginNodeInvokePolicyContext,
  ) => Promise<AforaPluginNodeInvokePolicyResult> | AforaPluginNodeInvokePolicyResult;
};

export type AforaPluginSecurityAuditContext = {
  config: AforaConfig;
  sourceConfig: AforaConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  configPath: string;
};

export type AforaPluginSecurityAuditCollector = (
  ctx: AforaPluginSecurityAuditContext,
) => SecurityAuditFinding[] | Promise<SecurityAuditFinding[]>;

export type AforaGatewayDiscoveryAdvertiseContext = {
  machineDisplayName: string;
  gatewayPort: number;
  gatewayTlsEnabled: boolean;
  gatewayTlsFingerprintSha256?: string;
  gatewayDirectReachable: boolean;
  canvasPort?: number;
  tailnetDns?: string;
  sshPort?: number;
  cliPath?: string;
  minimal: boolean;
};

export type AforaGatewayDiscoveryService = {
  id: string;
  advertise: (
    ctx: AforaGatewayDiscoveryAdvertiseContext,
  ) => void | Promise<void | { stop?: () => void | Promise<void> }>;
};

/** Context passed to long-lived plugin services. */
export type AforaPluginServiceContext = {
  config: AforaConfig;
  workspaceDir?: string;
  stateDir: string;
  logger: PluginLogger;
  gatewayEvents?: import("./gateway-events.js").AforaPluginGatewayEvents;
  startupTrace?: {
    detail?: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
    measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
  };
  internalDiagnostics?: {
    emit: (event: DiagnosticEventInput, privateData?: DiagnosticEventPrivateData) => void;
    onEvent: (
      listener: (
        event: DiagnosticEventPayload,
        metadata: DiagnosticEventMetadata,
        privateData: DiagnosticEventPrivateData,
      ) => void,
    ) => () => void;
    registerTracePropagationBridge?: (bridge: DiagnosticTracePropagationBridge) => () => void;
  };
};

/** Background service registered by a plugin during `register(api)`. */
export type AforaPluginService = {
  id: string;
  start: (ctx: AforaPluginServiceContext) => void | Promise<void>;
  stop?: (ctx: AforaPluginServiceContext) => void | Promise<void>;
};

export type AforaPluginChannelRegistration = {
  plugin: ChannelPlugin;
};

/**
 * Public label exposed to plugin `register(api)` calls.
 *
 * Keep this as a compatibility signal for plugin authors. Loader internals
 * should derive explicit capability booleans from the mode instead of branching
 * on raw strings throughout the code path.
 *
 * - `full`: live runtime activation; long-lived side effects may start.
 * - `discovery`: read-only capability discovery; skip sockets/workers/clients.
 * - `tool-discovery`: capability discovery for executable tools; skip channel runtime hydration.
 * - `setup-only`: lightweight channel setup entry only.
 * - `setup-runtime`: setup flow that also needs the runtime channel entry.
 * - `cli-metadata`: CLI command metadata collection.
 */
export type PluginRegistrationMode =
  | "full"
  | "discovery"
  | "tool-discovery"
  | "setup-only"
  | "setup-runtime"
  | "cli-metadata";
