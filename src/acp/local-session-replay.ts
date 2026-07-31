/** ACP local session replay selection and delivery. */
import type { AcpEventLedgerReplay } from "./event-ledger.js";
import type { AcpLocalSessionRuntime } from "./local-session-runtime.js";
import { extractReplayChunks } from "./translator.replay.js";
import type { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

export const EMPTY_ACP_EVENT_LEDGER_REPLAY: AcpEventLedgerReplay = {
  complete: false,
  events: [],
};

export async function resolveInitialLoadLedgerReplay(
  sessionUpdates: AcpTranslatorSessionUpdates,
  params: {
    explicitRouting: boolean;
    sessionId: string;
  },
): Promise<AcpEventLedgerReplay> {
  if (params.explicitRouting) {
    return EMPTY_ACP_EVENT_LEDGER_REPLAY;
  }
  const exact = await sessionUpdates.readLedgerReplayBySessionId(params.sessionId);
  if (exact.sessionKey) {
    return exact;
  }
  return await sessionUpdates.readLedgerReplayBySessionKey(params.sessionId);
}

export async function resolveLoadLedgerReplay(
  sessionUpdates: AcpTranslatorSessionUpdates,
  params: {
    explicitRouting: boolean;
    sessionId: string;
    sessionKey: string;
    ledgerSessionId?: string;
  },
): Promise<AcpEventLedgerReplay> {
  if (params.ledgerSessionId) {
    const retained = await sessionUpdates.readLedgerReplay({
      sessionId: params.ledgerSessionId,
      sessionKey: params.sessionKey,
    });
    if (retained.sessionKey === params.sessionKey) {
      return retained;
    }
  }
  if (!params.explicitRouting) {
    const exact = await sessionUpdates.readLedgerReplayBySessionId(params.sessionId);
    if (exact.sessionKey === params.sessionKey) {
      return exact;
    }
    const listed = await sessionUpdates.readLedgerReplayBySessionKey(params.sessionKey);
    if (listed.complete && listed.sessionKey === params.sessionKey) {
      return listed;
    }
  }
  return await sessionUpdates.readLedgerReplay({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });
}

export async function replayLocalSessionHistory(params: {
  sessionId: string;
  sessionKey: string;
  ledgerReplay: AcpEventLedgerReplay;
  sessionRuntime: AcpLocalSessionRuntime;
  sessionUpdates: AcpTranslatorSessionUpdates;
  log: (message: string) => void;
}): Promise<void> {
  if (params.ledgerReplay.complete) {
    for (const event of params.ledgerReplay.events) {
      await params.sessionUpdates.emit({
        sessionId: params.sessionId,
        update: event.update,
        record: false,
      });
    }
    return;
  }

  const transcript = await params.sessionRuntime
    .getSessionTranscript(params.sessionKey)
    .catch((error: unknown) => {
      params.log(`session transcript fallback for ${params.sessionKey}: ${String(error)}`);
      return [];
    });
  for (const message of transcript) {
    for (const chunk of extractReplayChunks(message)) {
      await params.sessionUpdates.emit({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: chunk.sessionUpdate,
          content: { type: "text", text: chunk.text },
        },
      });
    }
  }
}
