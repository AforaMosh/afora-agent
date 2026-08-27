import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import type { DB as AforaAgentKyselyDatabase } from "../../../state/afora-agent-db.generated.js";
import {
  openAforaAgentDatabase,
  type AforaAgentDatabaseOptions,
} from "../../../state/afora-agent-db.js";
import type { AcpParentStreamEvent } from "./acp-parent-stream-store.sqlite.js";

type AcpParentStreamDatabase = Pick<AforaAgentKyselyDatabase, "acp_parent_stream_events">;

export function listAcpParentStreamEventsForTest(
  options: AforaAgentDatabaseOptions & { sessionId: string; runId: string },
): AcpParentStreamEvent[] {
  const database = openAforaAgentDatabase(options);
  const db = getNodeSqliteKysely<AcpParentStreamDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("acp_parent_stream_events")
      .select("event_json")
      .where("session_id", "=", options.sessionId)
      .where("run_id", "=", options.runId)
      .orderBy("seq", "asc"),
  ).rows.map((row) => JSON.parse(row.event_json) as AcpParentStreamEvent);
}
