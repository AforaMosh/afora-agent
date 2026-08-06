/** Immutable transcript identity issued by the SQLite append transaction. */
export type TranscriptTurnAdmission = Readonly<{
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  generation: string;
  admittedEntryId: string;
  rawSeq: number;
  effectiveParentId: string | null;
  logicalIdempotencyKey: string;
}>;
