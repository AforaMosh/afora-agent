import type { ProgressCard, ProgressCardStep } from "../../packages/gateway-protocol/src/index.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../session-cards/progress-card-store.js";
import { withAforaAgentDatabaseReadOnly } from "../state/afora-agent-db-readonly.js";
import {
  openAforaAgentDatabase,
  runAforaAgentWriteTransaction,
} from "../state/afora-agent-db.js";
import { resolveGatewaySessionDatabase } from "./board-store.js";

export type ProgressCardStore = {
  get(sessionKey: string): ProgressCard | null;
  put(
    sessionKey: string,
    input: { markdown?: string; steps?: ProgressCardStep[] },
  ): { card: ProgressCard | null };
};

export const progressCardStore: ProgressCardStore = {
  get(sessionKey) {
    const resolved = resolveGatewaySessionDatabase(sessionKey);
    const result = withAforaAgentDatabaseReadOnly(
      (database) => readSessionProgressCard(database.db, resolved.sessionKey),
      {
        agentId: resolved.agentId,
        ...(resolved.path ? { path: resolved.path } : {}),
      },
    );
    return result.found ? result.value : null;
  },
  put(sessionKey, input) {
    const resolved = resolveGatewaySessionDatabase(sessionKey);
    const database = openAforaAgentDatabase({
      agentId: resolved.agentId,
      ...(resolved.path ? { path: resolved.path } : {}),
    });
    const result = runAforaAgentWriteTransaction(
      (transactionDatabase) =>
        writeSessionProgressCard(transactionDatabase.db, resolved.sessionKey, input),
      { agentId: resolved.agentId, path: database.path },
      { operationLabel: "progress-card.put" },
    );
    return "card" in result ? result : { card: null };
  },
};
