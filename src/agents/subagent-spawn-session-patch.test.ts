import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  upsertSqliteSessionEntry,
  upsertSqliteSessionEntryWithTrustedMemorySubject,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { readCurrentSessionMemorySubject } from "../config/sessions/session-memory-subject-access.js";
import { prepareAutonomousAgentSessionMemorySubjectSeed } from "../config/sessions/session-memory-subject.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

const tempDirectories = useAutoCleanupTempDirTracker(afterEach);

async function loadCreateInitialSubagentSession(params: {
  targetAgentId: string;
  storePath: string;
  canonicalKey: string;
}) {
  vi.resetModules();
  vi.doMock("./subagent-spawn.runtime.js", () => ({
    resolveGatewaySessionStoreTarget: () => ({
      agentId: params.targetAgentId,
      storePath: params.storePath,
      canonicalKey: params.canonicalKey,
      storeKeys: [params.canonicalKey],
    }),
    upsertSessionEntry: upsertSqliteSessionEntry,
    upsertSessionEntryWithTrustedMemorySubject: upsertSqliteSessionEntryWithTrustedMemorySubject,
  }));
  return (await import("./subagent-spawn-session-patch.js")).createInitialSubagentSession;
}

function createParams(params: {
  targetAgentId: string;
  childSessionKey: string;
  incognito: boolean;
}) {
  return {
    cfg: {} as OpenClawConfig,
    targetAgentId: params.targetAgentId,
    childSessionKey: params.childSessionKey,
    incognito: params.incognito,
    requesterInternalKey: "agent:requester:main",
    completionOwnerSessionKey: "agent:requester:main",
    modelPatch: {},
    collect: false,
  };
}

afterEach(() => {
  vi.doUnmock("./subagent-spawn.runtime.js");
  vi.resetModules();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("createInitialSubagentSession memory subject issuance", () => {
  it("assigns a durable native child to its target agent, not its requester lineage", async () => {
    const root = tempDirectories.make("openclaw-subagent-memory-subject-");
    const targetAgentId = "target";
    const canonicalKey = "agent:target:subagent:canonical-child";
    const storePath = path.join(root, "agents", targetAgentId, "sessions", "sessions.json");
    const createInitialSubagentSession = await loadCreateInitialSubagentSession({
      targetAgentId,
      storePath,
      canonicalKey,
    });

    const result = await createInitialSubagentSession(
      createParams({
        targetAgentId,
        childSessionKey: "agent:target:subagent:requested-child",
        incognito: false,
      }),
    );

    expect(result.status).toBe("ok");
    const snapshot = readCurrentSessionMemorySubject({
      agentId: targetAgentId,
      sessionKey: canonicalKey,
      storePath,
    });
    expect(snapshot?.subject).toEqual(
      prepareAutonomousAgentSessionMemorySubjectSeed(targetAgentId).subject,
    );
    expect(snapshot?.subject).not.toEqual(
      prepareAutonomousAgentSessionMemorySubjectSeed("requester").subject,
    );
  });

  it("keeps an incognito native child unbound and out of the durable target store", async () => {
    const root = tempDirectories.make("openclaw-subagent-incognito-memory-subject-");
    const targetAgentId = "target";
    const childSessionKey = "agent:target:subagent:incognito-child";
    const storePath = path.join(root, "agents", targetAgentId, "sessions", "sessions.json");
    const createInitialSubagentSession = await loadCreateInitialSubagentSession({
      targetAgentId,
      storePath,
      canonicalKey: childSessionKey,
    });

    const result = await createInitialSubagentSession(
      createParams({ targetAgentId, childSessionKey, incognito: true }),
    );

    expect(result.status).toBe("ok");
    expect(
      readCurrentSessionMemorySubject({
        agentId: targetAgentId,
        sessionKey: childSessionKey,
        storePath,
      })?.subject,
    ).toEqual({ version: 1, kind: "ambiguous", reason: "unbound" });

    const durableDatabase = openOpenClawAgentDatabase(
      toDatabaseOptions(
        resolveSqliteScope({
          agentId: targetAgentId,
          sessionKey: "agent:target:subagent:durable-probe",
          storePath,
        }),
      ),
    );
    expect(
      durableDatabase.db
        .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
        .get(childSessionKey),
    ).toBeUndefined();
  });
});
