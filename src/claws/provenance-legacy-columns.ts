// Projects additive Claw provenance columns that only writable opens can ensure.
import type { DatabaseSync } from "node:sqlite";

/**
 * Read-only opens never run the additive column migration, so a same-version
 * database written before a column existed must still answer planning reads.
 * Absent columns project as SQL NULL, which the row parsers already treat as
 * "no recorded provenance".
 */
export function legacySafeColumnProjection(
  db: DatabaseSync,
  table: "claw_installs" | "claw_package_refs",
  columns: readonly string[],
): string {
  const present = new Set(
    (
      db /* sqlite-allow-raw: schema probe for lazily added Claw provenance columns. */
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name?: unknown }>
    ).map((column) => String(column.name)),
  );
  return columns.map((column) => (present.has(column) ? column : `NULL AS ${column}`)).join(", ");
}
