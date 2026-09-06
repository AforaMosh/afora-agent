import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSharedAuthStorePath } from "../agents/auth-profiles/path-resolve.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  resolveAforaAgentSqlitePath,
  resolveAgentSqlitePathInDir,
} from "./afora-agent-db.paths.js";

/**
 * The hosted control plane pins AFORA_STATE_DIR at the tenant's existing state
 * directory, which makes `resolveStateDir` return before the one-time basename
 * migration can run. Every reader of the per-agent database therefore has to
 * resolve `openclaw-agent.sqlite` itself, or a paying tenant's conversation,
 * auth profiles and runtime tables are replaced by an empty database beside
 * the populated one.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function seedDatabase(pathname: string): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const db = new DatabaseSync(pathname);
  db.exec("CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)");
  db.close();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The rule, written out once. The host asserts this same four-shape table against its own two
 * readers in host/console-seed/state-contracts.test.mjs (BASENAME_RULE, section 4b). If the
 * two tables ever disagree, the console and the gateway are reading different files again.
 */
const BASENAME_RULE: ReadonlyArray<[string, readonly string[], string]> = [
  ["only the pre-rename name on disk", ["openclaw-agent.sqlite"], "openclaw-agent.sqlite"],
  ["only the current name on disk", ["afora-agent.sqlite"], "afora-agent.sqlite"],
  ["both on disk", ["afora-agent.sqlite", "openclaw-agent.sqlite"], "afora-agent.sqlite"],
  ["neither on disk, a tenant who has not started", [], "afora-agent.sqlite"],
];

describe("agent database basename resolution", () => {
  it.each(BASENAME_RULE)("resolves %s to the right database", (_what, onDisk, expected) => {
    const agentDir = makeTempDir("afora-agent-basename-");
    for (const basename of onDisk) {
      seedDatabase(path.join(agentDir, basename));
    }

    expect(resolveAgentSqlitePathInDir(agentDir)).toBe(path.join(agentDir, expected));
  });

  it("resolves a pinned tenant's populated database instead of an empty one", () => {
    const stateDir = makeTempDir("afora-agent-basename-pinned-");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    seedDatabase(path.join(agentDir, "openclaw-agent.sqlite"));

    expect(
      resolveAforaAgentSqlitePath({ agentId: "main", env: { AFORA_STATE_DIR: stateDir } }),
    ).toBe(path.join(agentDir, "openclaw-agent.sqlite"));
  });

  it("keeps an explicit database path exactly as the caller named it", () => {
    const agentDir = makeTempDir("afora-agent-basename-explicit-");
    seedDatabase(path.join(agentDir, "openclaw-agent.sqlite"));
    const explicit = path.join(agentDir, "afora-agent.sqlite");

    expect(resolveAforaAgentSqlitePath({ agentId: "main", path: explicit })).toBe(explicit);
  });

  it("points the shared-main auth store at the same file as the agent database", () => {
    const stateDir = makeTempDir("afora-agent-basename-auth-");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    seedDatabase(path.join(agentDir, "openclaw-agent.sqlite"));
    const env = { AFORA_STATE_DIR: stateDir } as NodeJS.ProcessEnv;

    expect(resolveSharedAuthStorePath(env)).toBe(
      resolveAforaAgentSqlitePath({ agentId: "main", env }),
    );
    expect(resolveSharedAuthStorePath(env)).toBe(path.join(agentDir, "openclaw-agent.sqlite"));
  });

  it("still recognises which agent owns a legacy-named database path", () => {
    const stateDir = makeTempDir("afora-agent-basename-owner-");
    const storePath = path.join(stateDir, "agents", "ops", "agent", "openclaw-agent.sqlite");

    expect(resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath)).toEqual({
      agentId: "ops",
      path: storePath,
    });
  });
});
