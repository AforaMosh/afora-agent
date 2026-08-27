// Private local-only SQLite lifecycle helpers for first-party tests.

import {
  appendTranscriptEvent,
  type SessionTranscriptAccessScope,
  type TranscriptEvent,
} from "../config/sessions/session-accessor.js";

/** Appends a raw SQLite transcript event for first-party tests only. */
export async function appendSqliteSessionTranscriptEventForTest(
  params: SessionTranscriptAccessScope & { event: TranscriptEvent },
): Promise<void> {
  await appendTranscriptEvent(params, params.event);
}

export { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
export {
  appendSqliteTrajectoryRuntimeEvents,
  loadSqliteTrajectoryRuntimeEvents,
  type SqliteTrajectoryRuntimeScope,
} from "../trajectory/runtime-store.sqlite.js";
export { type TrajectoryEvent as SqliteTrajectoryRuntimeEventForTest } from "../trajectory/types.js";
export {
  closeAforaAgentDatabasesForTest,
  openAforaAgentDatabase,
} from "../state/afora-agent-db.js";
export {
  closeAforaStateDatabaseForTest,
  openAforaStateDatabase,
} from "../state/afora-state-db.js";
