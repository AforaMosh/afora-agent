/**
 * Runtime guards for sandbox exec-server handlers that need backend-specific
 * execution and filesystem bridges.
 */
import type { SandboxContext } from "afora-agent/plugin-sdk/sandbox";
import type { AforaExecServer } from "./types.js";

/** Returns the configured sandbox backend or fails the current JSON-RPC request. */
export function requireBackend(
  execServer: AforaExecServer,
): NonNullable<SandboxContext["backend"]> {
  const backend = execServer.sandbox.backend;
  if (!backend) {
    throw new Error("Afora sandbox backend is unavailable.");
  }
  return backend;
}

/** Returns the configured filesystem bridge or fails the current JSON-RPC request. */
export function requireFsBridge(
  execServer: AforaExecServer,
): NonNullable<SandboxContext["fsBridge"]> {
  const fsBridge = execServer.sandbox.fsBridge;
  if (!fsBridge) {
    throw new Error("Sandbox filesystem bridge is unavailable.");
  }
  return fsBridge;
}
