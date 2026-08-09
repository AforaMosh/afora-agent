import type { SqliteSessionStateDeletePlan } from "./session-accessor.sqlite-archive.js";
import type {
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
} from "./session-accessor.sqlite-contract.js";
import type { TrustedSessionMemorySubjectIssuer } from "./session-memory-subject-trust.js";
import type { SessionResetBoundaryPlan } from "./session-reset-boundary-event.js";
import type { SessionEntry } from "./types.js";

// Shared plan shapes only. Runtime ownership stays in maintenance and lifecycle-state.

export type SqliteSessionEntryRemovalPlan = {
  expectedEntry: SessionEntry | undefined;
  sessionKey: string;
};
export type SqliteSessionEntryMaintenancePlan = {
  entryRemovals: SqliteSessionEntryRemovalPlan[];
  stateDeletePlans: SqliteSessionStateDeletePlan[];
};
export type SqliteLifecycleArtifactCleanupPlan = {
  deletePlans: SqliteSessionStateDeletePlan[];
  entries: SqliteSessionEntryRemovalPlan[];
};

/** Internal-only trusted issuer retained until the synchronous SQLite commit. */
export type TrustedSqliteSessionEntryLifecycleUpsert = SessionEntryLifecycleUpsert & {
  /** Doctor-only: a selected cross-store subject is copied after its node/window rows exist. */
  deferMemorySubjectPersistence?: true;
  memorySubjectIssuer?: TrustedSessionMemorySubjectIssuer;
};

export type SqliteProjectedLifecycleMutation = {
  deletePlans: SqliteSessionStateDeletePlan[];
  removals: Array<{
    expectedEntry: SessionEntry;
    removal: SessionEntryLifecycleRemoval;
    sessionKey: string;
  }>;
  upsertedEntries: Array<{
    deferMemorySubjectPersistence?: true;
    entry: SessionEntry;
    expectedEntry: SessionEntry | undefined;
    memorySubjectIssuer?: TrustedSessionMemorySubjectIssuer;
    resetBoundaryPlan?: SessionResetBoundaryPlan;
    sessionKey: string;
  }>;
};
