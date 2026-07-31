/** Parses ACP request metadata into process-local session routing hints. */
import { readBool, readString } from "@openclaw/acp-core/meta";

export type AcpSessionMeta = {
  sessionKey?: string;
  sessionLabel?: string;
  resetSession?: boolean;
  requireExisting?: boolean;
  prefixCwd?: boolean;
};

/** Parses ACP request metadata into OpenClaw session routing hints. */
export function parseSessionMeta(meta: unknown): AcpSessionMeta {
  if (!meta || typeof meta !== "object") {
    return {};
  }
  const record = meta as Record<string, unknown>;
  return {
    sessionKey: readString(record, ["sessionKey", "session", "key"]),
    sessionLabel: readString(record, ["sessionLabel", "label"]),
    resetSession: readBool(record, ["resetSession", "reset"]),
    requireExisting: readBool(record, ["requireExistingSession", "requireExisting"]),
    prefixCwd: readBool(record, ["prefixCwd"]),
  };
}
