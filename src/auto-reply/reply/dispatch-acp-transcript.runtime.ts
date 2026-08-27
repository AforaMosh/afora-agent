// Bridges ACP transcript events into persisted Afora session transcripts.
import { resolveAcpSessionCwd } from "@afora/acp-core/runtime/session-identifiers";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { persistAcpTurnTranscript } from "../../agents/command/attempt-execution.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { AforaConfig } from "../../config/types.afora.js";

export async function persistAcpDispatchTranscript(params: {
  cfg: AforaConfig;
  sessionKey: string;
  promptText: string;
  finalText: string;
  meta?: SessionAcpMeta;
  threadId?: string | number;
}): Promise<void> {
  const promptText = params.promptText.trim();
  const finalText = params.finalText.trim();
  if (!promptText && !finalText) {
    return;
  }

  const sessionAgentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: sessionAgentId,
  });
  const sessionEntry = loadSessionEntryReadOnly({
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    storePath,
  });
  const sessionId = sessionEntry?.sessionId;
  if (!sessionId) {
    throw new Error(`unknown ACP session key: ${params.sessionKey}`);
  }

  await persistAcpTurnTranscript({
    body: promptText,
    transcriptBody: promptText,
    finalText,
    sessionId,
    sessionKey: params.sessionKey,
    sessionEntry,
    storePath,
    sessionAgentId,
    threadId: params.threadId,
    sessionCwd: resolveAcpSessionCwd(params.meta) ?? process.cwd(),
    config: params.cfg,
  });
}
