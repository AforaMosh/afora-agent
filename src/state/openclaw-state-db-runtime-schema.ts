import {
  FIRST_USE_STATE_INDEXES,
  FIRST_USE_STATE_TABLES,
  LAZY_ADDITIVE_STATE_INDEXES,
  LAZY_ADDITIVE_STATE_TABLES,
} from "./openclaw-state-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export function canonicalStateSchemaForRuntime(options: {
  includeVersionLazyAdditiveTables: boolean;
}): string {
  // Current-version databases may lack lazy additive tables. First-use tables
  // remain absent on every schema path so only their feature owner can create them.
  let eagerSchema = OPENCLAW_STATE_SCHEMA_SQL;
  const omittedTables = options.includeVersionLazyAdditiveTables
    ? FIRST_USE_STATE_TABLES
    : LAZY_ADDITIVE_STATE_TABLES;
  const omittedIndexes = options.includeVersionLazyAdditiveTables
    ? FIRST_USE_STATE_INDEXES
    : LAZY_ADDITIVE_STATE_INDEXES;
  for (const tableName of omittedTables) {
    const startMarker = `CREATE TABLE IF NOT EXISTS ${tableName} (`;
    const start = eagerSchema.indexOf(startMarker);
    const endMarker = "\n) STRICT;";
    const end = start >= 0 ? eagerSchema.indexOf(endMarker, start) : -1;
    if (start < 0 || end < 0) {
      throw new Error(`lazy additive state schema block is missing for ${tableName}`);
    }
    eagerSchema = `${eagerSchema.slice(0, start)}${eagerSchema.slice(end + endMarker.length)}`;
  }
  for (const indexName of omittedIndexes) {
    const startMarker = `CREATE INDEX IF NOT EXISTS ${indexName}`;
    const start = eagerSchema.indexOf(startMarker);
    const end = start >= 0 ? eagerSchema.indexOf(";", start) : -1;
    if (start < 0 || end < 0) {
      throw new Error(`lazy additive state schema index is missing for ${indexName}`);
    }
    eagerSchema = `${eagerSchema.slice(0, start)}${eagerSchema.slice(end + 1)}`;
  }
  return eagerSchema;
}
