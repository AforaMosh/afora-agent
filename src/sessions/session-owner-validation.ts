import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  readAcpSessionMeta,
  readAcpSessionMetaForEntry,
  repairAcpSessionMetaKeyForMigration,
} from "../acp/runtime/session-meta.js";
import { listAgentIds } from "../agents/agent-scope.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { isAcpSessionKey } from "./session-key-utils.js";

/**
 * Returns the owning agent id if the session key belongs to an agent that is no
 * longer present in config. Confirmed free ACP runtime sessions are ownerless.
 */
export function resolveDeletedAgentIdFromSessionKey(
  cfg: OpenClawConfig,
  sessionKey: string,
  entry?: SessionEntry | null,
  options?: { acpMetadataSessionKey?: string | null },
): string | null {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return null;
  }
  const agentId = normalizeAgentId(parsed.agentId);
  if (listAgentIds(cfg).includes(agentId)) {
    return null;
  }
  if (isAcpSessionKey(sessionKey) && !parsed.rest.startsWith("acp:binding:")) {
    // ACP-shaped keys are not proof of a free runtime session. Bridge sessions can use the same
    // shape, while configured acp:binding keys remain owner-scoped even when metadata exists.
    const acpMeta = readAcpMetaForDeletedAgentCheck({
      cfg,
      sessionKey,
      entry,
      acpMetadataSessionKey: options?.acpMetadataSessionKey,
    });
    if (acpMeta) {
      return null;
    }
  }
  return agentId;
}

function readAcpMetaForDeletedAgentCheck(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  entry?: Pick<SessionEntry, "acp" | "lifecycleRevision"> | null;
  acpMetadataSessionKey?: string | null;
}) {
  if (params.entry?.acp) {
    return params.entry.acp;
  }

  const acpMetadataSessionKey = normalizeOptionalString(params.acpMetadataSessionKey);
  const directKeys = new Set<string>();
  if (acpMetadataSessionKey) {
    directKeys.add(acpMetadataSessionKey);
  } else {
    const acpMeta = readAcpSessionMeta({ sessionKey: params.sessionKey, cfg: params.cfg });
    if (acpMeta) {
      return acpMeta;
    }
  }
  directKeys.add(params.sessionKey);

  for (const directKey of directKeys) {
    const acpMeta = readAcpSessionMetaForEntry({
      sessionKey: directKey,
      entry: params.entry ?? undefined,
    });
    if (acpMeta) {
      return acpMeta;
    }
  }

  repairAcpSessionMetaKeyForMigration({
    sessionKey: params.sessionKey,
    candidateSessionKeys: directKeys,
    entry: params.entry ?? undefined,
  });
  return readAcpSessionMetaForEntry({
    sessionKey: params.sessionKey,
    entry: params.entry ?? undefined,
  });
}
