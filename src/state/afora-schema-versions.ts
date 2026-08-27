export type AforaSchemaVersions = {
  state: number;
  agent: number;
};

export function parseAforaSchemaVersions(value: unknown): AforaSchemaVersions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.state) ||
    (record.state as number) < 0 ||
    !Number.isInteger(record.agent) ||
    (record.agent as number) < 0
  ) {
    return undefined;
  }
  return { state: record.state as number, agent: record.agent as number };
}

export function parsePackageAforaSchemaVersions(
  packageJson: unknown,
): AforaSchemaVersions | undefined {
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    return undefined;
  }
  const record = packageJson as Record<string, unknown>;
  const meta = record.afora ?? record.openclaw; // afora-compat: older releases keep the legacy package.json key
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  return parseAforaSchemaVersions((meta as Record<string, unknown>).schemaVersions);
}
