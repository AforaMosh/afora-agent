import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { LEGACY_AGENT_LIST_MIGRATION_MESSAGE } from "../../../config/legacy.roster.js";
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";

/** Resolve final list-slot ids before Doctor converts the authored array to keyed entries. */
export function prepareAgentEntriesDoctorMigrationInput(params: {
  authored: unknown;
  resolvedBeforeMigrations: unknown;
}): Record<string, unknown> | undefined {
  const authoredRoot = getRecord(params.authored);
  const authoredAgents = getRecord(authoredRoot?.agents);
  if (!authoredRoot || !authoredAgents || !Array.isArray(authoredAgents.list)) {
    return undefined;
  }
  if (authoredAgents.list.some((value) => getRecord(value)?.$include !== undefined)) {
    // A whole-entry include owns both the legacy id and its file. Migrating it requires a
    // coordinated root/include rewrite, so retain the existing write fallback for that shape.
    return undefined;
  }
  const resolvedRoot = getRecord(params.resolvedBeforeMigrations);
  const resolvedAgents = getRecord(resolvedRoot?.agents);
  const resolvedList = Array.isArray(resolvedAgents?.list) ? resolvedAgents.list : [];
  const list = authoredAgents.list.map((value, index) => {
    const entry = getRecord(value);
    const resolvedEntry = getRecord(resolvedList[index]);
    const resolvedId = resolvedEntry?.id;
    if (!entry || typeof resolvedId !== "string" || !resolvedId.trim()) {
      return value;
    }
    return { ...entry, id: resolvedId };
  });
  return { ...authoredRoot, agents: { ...authoredAgents, list } };
}

function migrateAgentEntries(raw: Record<string, unknown>, changes: string[]): void {
  const agents = getRecord(raw.agents);
  if (!agents || !Array.isArray(agents.list)) {
    return;
  }
  if (getRecord(agents.entries)) {
    delete agents.list;
    changes.push("Removed agents.list because canonical agents.entries is already set.");
    return;
  }
  const entries: Record<string, unknown> = {};
  for (const [index, value] of agents.list.entries()) {
    const entry = getRecord(value);
    if (!entry) {
      changes.push(`Removed malformed agents.list[${index}] entry.`);
      continue;
    }
    const rawId = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "agent";
    const requestedId = normalizeAgentId(rawId);
    if (requestedId !== rawId) {
      changes.push(`Normalized agents.list id "${rawId}" → agents.entries.${requestedId}.`);
    }
    let key = requestedId;
    let suffix = 2;
    while (Object.hasOwn(entries, key)) {
      key = `${requestedId}-${suffix}`;
      suffix += 1;
    }
    const { id: _id, ...config } = entry;
    Object.defineProperty(entries, key, {
      configurable: true,
      enumerable: true,
      value: config,
      writable: true,
    });
    if (key !== requestedId) {
      changes.push(`Moved duplicate agents.list id "${requestedId}" to agents.entries.${key}.`);
    }
  }
  agents.entries = entries;
  delete agents.list;
  changes.push("Moved agents.list → keyed agents.entries.");
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_ENTRIES: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "runtime.agents-entries",
    describe: "Move agent arrays to keyed entries",
    legacyRules: [
      {
        path: ["agents", "list"],
        message: LEGACY_AGENT_LIST_MIGRATION_MESSAGE,
      },
    ],
    apply: migrateAgentEntries,
  }),
];
