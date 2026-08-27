// Node-host plugin command contracts, including the opt-in duplex transport.
import type { AforaConfig } from "../config/types.afora.js";

export type AforaPluginNodeHostCommandAvailabilityContext = {
  /** Node-local configuration used to build this host's Gateway declaration. */
  config: AforaConfig;
  /** Node-host process environment. */
  env: NodeJS.ProcessEnv;
};

export type AforaPluginNodeHostCommandIo = {
  emitChunk(chunk: string): Promise<void>;
  onInput(callback: (payloadJSON: string) => void): void;
  signal: AbortSignal;
};

export type AforaPluginNodeHostCommandContext = {
  /** Emit one node-owned event through the active Gateway connection. */
  sendNodeEvent(event: string, payload: unknown): Promise<unknown>;
  /** Agent session that owns this invocation, when the caller supplied one. */
  sessionKey?: string;
  /** Aborts when the Gateway cancels this specific node-host invocation. */
  signal?: AbortSignal;
};

type AforaPluginNodeHostCommandBase = {
  command: string;
  cap?: string;
  dangerous?: boolean;
  /** Return false to omit this command and capability from the node declaration. */
  isAvailable?: (context: AforaPluginNodeHostCommandAvailabilityContext) => boolean;
  /** Watch node-local availability and request a fresh Gateway declaration. */
  watchAvailability?: (
    context: AforaPluginNodeHostCommandAvailabilityContext,
    onChange: () => void,
  ) => (() => void) | void;
  /** Release command-owned state when the active Gateway connection closes. */
  onDisconnect?: () => Promise<void> | void;
  /** Optional Computer Use declaration published with this command's node manifest. */
  computerUse?: (context: AforaPluginNodeHostCommandAvailabilityContext) => unknown;
  agentTool?: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
    /** Platforms where this tool is allowlisted by default; omit for explicit config only. */
    defaultPlatforms?: Array<"ios" | "android" | "macos" | "windows" | "linux" | "unknown">;
    mcp?: { server: string; tool: string };
  };
};

export type AforaPluginNodeHostCommand = AforaPluginNodeHostCommandBase & {
  // Not a discriminated handle signature: a union of different arities makes
  // plain `command.handle(params)` uncallable for consumers holding the union.
  // The node host enforces io presence for duplex commands at runtime.
  duplex?: boolean;
  handle: (
    paramsJSON?: string | null,
    io?: AforaPluginNodeHostCommandIo,
    context?: AforaPluginNodeHostCommandContext,
  ) => Promise<string>;
};
