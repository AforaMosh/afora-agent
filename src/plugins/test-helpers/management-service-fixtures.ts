export function metadataSnapshot(params: {
  enabled?: boolean;
  id?: string;
  name?: string;
  origin?: "bundled" | "global";
  packageName?: string | null;
  installRecord?: Record<string, unknown>;
  featured?: boolean;
  description?: string;
  icon?: string;
}) {
  const id = params.id ?? "workboard";
  const origin = params.origin ?? "bundled";
  const packageName =
    params.packageName === null ? undefined : (params.packageName ?? `@openclaw/${id}`);
  const installRecord =
    params.installRecord ??
    (origin === "global" ? { source: "path", installPath: `/tmp/${id}` } : undefined);
  const manifest = {
    id,
    name: params.name ?? "Workboard",
    description: params.description ?? "Coordinate agent work in a shared board.",
    catalog: { featured: params.featured ?? true, order: 10 },
    ...(params.icon ? { icon: params.icon } : {}),
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin,
    rootDir: `/tmp/${id}`,
    source: `/tmp/${id}/index.ts`,
    manifestPath: `/tmp/${id}/openclaw.plugin.json`,
  };
  return {
    index: {
      plugins: [
        {
          pluginId: id,
          ...(origin === "global" ? { installOwner: id } : {}),
          ...(packageName ? { packageName } : {}),
          origin,
          enabled: params.enabled ?? true,
          rootDir: `/tmp/${id}`,
        },
      ],
      installRecords: installRecord ? { [id]: installRecord } : {},
    },
    byPluginId: new Map([[id, manifest]]),
    plugins: [manifest],
    diagnostics: [],
    normalizePluginId: (pluginId: string) => pluginId,
  };
}

export function emptyMetadataSnapshot() {
  return {
    index: { plugins: [], installRecords: {} },
    byPluginId: new Map(),
    plugins: [],
    diagnostics: [],
    normalizePluginId: (pluginId: string) => pluginId,
  };
}
