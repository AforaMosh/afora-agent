import type { Result } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type SessionSelector = {
  key?: string | null;
  sessionId?: string | null;
  label?: string | null;
  agentId?: string;
  spawnedBy?: string;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
  allowMissing?: boolean;
};

type ResolvedSession = {
  key: string;
};

export type SessionResolveError = {
  kind: "agent-not-found" | "ambiguous" | "invalid-label" | "invalid-selector" | "not-found";
  message: string;
};

export type SessionResolveInput = {
  config: OpenClawConfig;
  selector: SessionSelector;
};

export type SessionResolveResult = Result<ResolvedSession | null, SessionResolveError>;

export interface SessionServiceContract {
  resolve(input: SessionResolveInput): Promise<SessionResolveResult>;
}
