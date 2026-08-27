const GATEWAY_STATE_SCHEMA_MIGRATION_REQUIRED_REASON = "gateway.state_schema_migration_required";

type AforaStateDatabaseSchemaMigrationRequiredKind =
  | "agent-databases-composite-primary-key"
  | "audit-events-v2";

export class AforaStateDatabaseSchemaMigrationRequiredError extends Error {
  readonly code = GATEWAY_STATE_SCHEMA_MIGRATION_REQUIRED_REASON;

  constructor(
    readonly kind: AforaStateDatabaseSchemaMigrationRequiredKind,
    readonly pathname: string,
  ) {
    super(
      `Afora state database schema migration required (${kind}) at ${pathname}; run afora doctor --fix to migrate it.`,
    );
    this.name = "AforaStateDatabaseSchemaMigrationRequiredError";
  }
}

const STATE_SCHEMA_MIGRATION_REQUIRED_MESSAGE =
  /^Afora state database schema migration required \((agent-databases-composite-primary-key|audit-events-v2)\) at (.+); run afora doctor --fix to migrate it\.$/u;

function parseStateSchemaMigrationRequiredMessage(
  message: unknown,
): AforaStateDatabaseSchemaMigrationRequiredError | undefined {
  if (typeof message !== "string") {
    return undefined;
  }
  const match = STATE_SCHEMA_MIGRATION_REQUIRED_MESSAGE.exec(message);
  const kind = match?.[1] as AforaStateDatabaseSchemaMigrationRequiredKind | undefined;
  const pathname = match?.[2];
  if (!kind || !pathname) {
    return undefined;
  }
  return new AforaStateDatabaseSchemaMigrationRequiredError(kind, pathname);
}

export function findAforaStateDatabaseSchemaMigrationRequiredError(
  error: unknown,
): AforaStateDatabaseSchemaMigrationRequiredError | undefined {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    if (current instanceof AforaStateDatabaseSchemaMigrationRequiredError) {
      return current;
    }
    const errorLike = current as { cause?: unknown; message?: unknown };
    const parsed = parseStateSchemaMigrationRequiredMessage(errorLike.message);
    if (parsed) {
      return parsed;
    }
    seen.add(current);
    current = errorLike.cause;
  }
  return undefined;
}
