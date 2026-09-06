// Agent database path helpers resolve per-agent persisted database paths.
import fs from "node:fs";
import path from "node:path";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAforaStateSqliteDir } from "./afora-state-db.paths.js";

/**
 * Path helpers for per-agent SQLite state.
 *
 * Agent databases live beside the shared state database root so each agent can
 * own private runtime tables while the shared registry can still discover them.
 */
/** Inputs for resolving one agent SQLite path or directory. */
type AforaAgentSqlitePathOptions = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
};

const INCOGNITO_AGENT_SQLITE_BASENAME = "incognito-afora-agent.sqlite";
const AGENT_SQLITE_BASENAME = "afora-agent.sqlite";
const LEGACY_AGENT_SQLITE_BASENAME = "openclaw-agent.sqlite"; // afora-compat: legacy basename

/** Every basename one agent database can legitimately carry on disk. */
export const AGENT_SQLITE_BASENAMES: ReadonlySet<string> = new Set([
  AGENT_SQLITE_BASENAME,
  LEGACY_AGENT_SQLITE_BASENAME, // afora-compat: unmigrated tenants
]);

/**
 * Resolve the agent database inside one agent directory.
 *
 * afora-compat: a tenant whose state directory is named explicitly (the hosted
 * control plane pins AFORA_STATE_DIR) never runs the one-time basename rename
 * in `resolveStateDir`, so their conversation, auth profiles and runtime tables
 * are still in `openclaw-agent.sqlite`. Read that file where the canonical one
 * is absent rather than silently starting an empty database beside it. Nothing
 * is moved or renamed: the legacy file keeps its name for as long as it exists.
 */
export function resolveAgentSqlitePathInDir(agentDir: string): string {
  const canonical = path.join(agentDir, AGENT_SQLITE_BASENAME);
  const legacy = path.join(agentDir, LEGACY_AGENT_SQLITE_BASENAME); // afora-compat
  return !fs.existsSync(canonical) && fs.existsSync(legacy) ? legacy : canonical;
}

/** Resolve the SQLite file for one normalized agent id. */
export function resolveAforaAgentSqlitePath(options: AforaAgentSqlitePathOptions): string {
  const agentId = normalizeAgentId(options.agentId);
  return path.resolve(
    options.path ??
      resolveAgentSqlitePathInDir(
        path.join(
          path.dirname(resolveAforaStateSqliteDir(options.env ?? process.env)),
          "agents",
          agentId,
          "agent",
        ),
      ),
  );
}

/** Resolve the lexical sentinel path that keys one agent's process-held incognito database. */
export function resolveIncognitoAforaAgentSqlitePath(
  options: Omit<AforaAgentSqlitePathOptions, "path">,
): string {
  return path.join(
    path.dirname(resolveAforaAgentSqlitePath(options)),
    INCOGNITO_AGENT_SQLITE_BASENAME,
  );
}

/** Identify the reserved incognito sentinel without touching its filesystem path. */
export function isIncognitoAforaAgentSqlitePath(
  pathname: string,
  options: Omit<AforaAgentSqlitePathOptions, "path">,
): boolean {
  return path.resolve(pathname) === resolveIncognitoAforaAgentSqlitePath(options);
}
