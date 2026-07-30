import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  loadExactSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { getSessionProjectedTitle } from "../config/sessions/session-accessor.sqlite-session-row.js";
import { mergeCanonicalSessionEntryCandidates } from "../config/sessions/session-canonical-key.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  deliveryContextFromSession,
  normalizeSessionDeliveryState,
} from "../utils/delivery-context.shared.js";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

function insertLegacySession(params: {
  agentId: string;
  entry: SessionEntry;
  env: NodeJS.ProcessEnv;
  eventText?: string;
  sessionKey: string;
  storePath: string;
}): void {
  const database = openOpenClawAgentDatabase({
    agentId: params.agentId,
    env: params.env,
    path: resolveSqliteTargetFromSessionStorePath(params.storePath, {
      agentId: params.agentId,
      env: params.env,
    }).path,
  });
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(
      params.sessionKey,
      params.entry.sessionId,
      JSON.stringify(params.entry),
      params.entry.updatedAt,
    );
  database.db
    .prepare(
      "INSERT INTO session_windows (session_id, session_key, reason, session_scope, created_at, updated_at) VALUES (?, ?, 'initial', 'conversation', ?, ?)",
    )
    .run(params.entry.sessionId, params.sessionKey, params.entry.updatedAt, params.entry.updatedAt);
  if (params.eventText) {
    database.db
      .prepare(
        "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 0, ?, ?)",
      )
      .run(
        params.entry.sessionId,
        JSON.stringify({
          id: `${params.entry.sessionId}-message`,
          message: { content: params.eventText, role: "user" },
          parentId: null,
          type: "message",
        }),
        params.entry.updatedAt,
      );
  }
}

describe("doctor canonical session-key repair", () => {
  it("selects a finite updatedAt over a legacy missing timestamp", () => {
    expect(
      mergeCanonicalSessionEntryCandidates([
        { entry: { sessionId: "legacy" } as SessionEntry, value: "legacy" },
        { entry: { sessionId: "newer", updatedAt: 10 }, value: "newer" },
      ])?.winner,
    ).toBe("newer");
  });

  it.each([
    {
      canonicalKey: "agent:main:matrix:channel:!MixedCase:example.org",
      channel: "matrix",
      chatType: "channel" as const,
      label: "Matrix room",
      to: "!MixedCase:example.org",
    },
    {
      canonicalKey: "agent:main:signal:group:VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=",
      channel: "signal",
      chatType: "group" as const,
      label: "Signal group",
      to: "signal:group:VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=",
    },
  ])("restores a delivery-proven lowercased $label alias", async (fixture) => {
    await withStateDirEnv("openclaw-doctor-canonical-delivery-alias-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveStorePath(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      const legacyKey = fixture.canonicalKey.toLowerCase();
      insertLegacySession({
        agentId: "main",
        entry: {
          chatType: fixture.chatType,
          delivery: normalizeSessionDeliveryState({
            context: { channel: fixture.channel, to: fixture.to },
          }),
          sessionId: `${fixture.channel}-legacy-session`,
          updatedAt: 10,
        },
        env,
        eventText: `${fixture.label} history`,
        sessionKey: legacyKey,
        storePath,
      });
      const childKey = `agent:main:${fixture.channel}-child`;
      insertLegacySession({
        agentId: "main",
        entry: {
          parentSessionKey: legacyKey,
          sessionId: `${fixture.channel}-child-session`,
          updatedAt: 5,
        },
        env,
        sessionKey: childKey,
        storePath,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 2,
        removedRows: 1,
        repairedGroups: 2,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: fixture.canonicalKey,
          storePath,
        })?.entry.sessionId,
      ).toBe(`${fixture.channel}-legacy-session`);
      expect(
        loadExactSessionEntryReadOnly({ agentId: "main", env, sessionKey: legacyKey, storePath }),
      ).toBeUndefined();
      expect(
        loadExactSessionEntryReadOnly({ agentId: "main", env, sessionKey: childKey, storePath })
          ?.entry.parentSessionKey,
      ).toBe(fixture.canonicalKey);
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: `${fixture.channel}-legacy-session`,
          sessionKey: fixture.canonicalKey,
          storePath,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: `${fixture.label} history` }),
        }),
      ]);
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });

  it("prefers the canonical destination when repair timestamps tie", () => {
    expect(
      mergeCanonicalSessionEntryCandidates([
        { entry: { sessionId: "wrong-store", updatedAt: 10 }, value: "wrong-store" },
        {
          entry: { sessionId: "canonical", updatedAt: 10 },
          preferred: true,
          value: "canonical",
        },
      ])?.winner,
    ).toBe("canonical");
  });

  it("is a no-op for fresh stores and remains idempotent after repair", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-fresh-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveStorePath(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:main", storePath },
        { sessionId: "fresh", updatedAt: 10 },
      );

      expect(await repairCanonicalSessionKeys({ apply: false, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env }).path,
      });
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(
          JSON.stringify({ sessionId: "\0invalid", subject: "legacy", updatedAt: 10 }),
          "agent:main:main",
        );
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 0,
        repairedGroups: 1,
      });
      expect(
        JSON.parse(
          (
            database.db
              .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
              .get("agent:main:main") as { entry_json: string }
          ).entry_json,
        ),
      ).toMatchObject({ sessionId: "fresh", subject: "legacy", updatedAt: 10 });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });

  it("rehomes matching in-store transcript generations under the canonical key", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-rehome-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveStorePath(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:work", storePath },
        { previousSessionId: "older", sessionId: "newer", updatedAt: 20 },
      );
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "older", subject: "preserved", updatedAt: 10 },
        env,
        eventText: "older history",
        sessionKey: "agent:main:main",
        storePath,
      });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env }).path,
      });
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(JSON.stringify({ sessionId: "older", subject: "preserved" }), "agent:main:main");

      const first = await repairCanonicalSessionKeys({ apply: true, cfg, env });
      expect(first).toMatchObject({ foundGroups: 1, removedRows: 1, repairedGroups: 1 });
      expect(first.archivedTranscriptDirectories).toEqual([]);
      expect(
        database.db
          .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
          .get("older"),
      ).toEqual({ session_key: "agent:main:work" });
      expect(
        database.db
          .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
          .get("older"),
      ).toEqual({ count: 1 });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });

  it("replaces same-store membership from the selected alias winner", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-members-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveStorePath(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:work", storePath },
        { sessionId: "shared-session", updatedAt: 10 },
      );
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "alias-winner-session", updatedAt: 20 },
        env,
        sessionKey: "agent:main:main",
        storePath,
      });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env }).path,
      });
      const insertMember = database.db.prepare(
        "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, ?, 'owner', 10)",
      );
      insertMember.run("agent:main:work", "canonical-member");
      insertMember.run("agent:main:main", "winner-member");

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(database.db.prepare("SELECT identity_id FROM session_members").all()).toEqual([
        { identity_id: "winner-member" },
      ]);
    });
  });

  it("keeps sentinel rows scoped to their owning agent stores", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-sentinels-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveStorePath(storeTemplate, { agentId: "main", env });
      const opsStore = resolveStorePath(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "global", storePath: mainStore },
        { sessionId: "main-global", updatedAt: 10 },
      );
      insertLegacySession({
        agentId: "ops",
        env,
        sessionKey: "global",
        storePath: opsStore,
        entry: {
          parentSessionKey: "parent",
          sessionId: "ops-global",
          spawnedBy: "controller",
          updatedAt: 20,
        },
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "global",
          storePath: mainStore,
        })?.entry.sessionId,
      ).toBe("main-global");
      const opsGlobal = loadExactSessionEntryReadOnly({
        agentId: "ops",
        env,
        sessionKey: "global",
        storePath: opsStore,
      })?.entry;
      expect(opsGlobal).toMatchObject({
        parentSessionKey: "agent:ops:parent",
        sessionId: "ops-global",
        spawnedBy: "agent:ops:controller",
      });
    });
  });

  it("normalizes persisted lineage keys before runtime SQL filtering", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-lineage-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveStorePath(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "main",
        env,
        sessionKey: "agent:main:child",
        storePath,
        entry: {
          forkSource: {
            entryId: "fork-entry",
            sessionId: "fork-session",
            sessionKey: "Agent:Main:Fork ",
          },
          parentSessionKey: "Agent:Main:Parent ",
          sessionId: "child",
          spawnedBy: " ",
          updatedAt: 10,
        },
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:child",
          storePath,
        })?.entry,
      ).toMatchObject({
        forkSource: {
          entryId: "fork-entry",
          sessionId: "fork-session",
          sessionKey: "agent:main:fork",
        },
        parentSessionKey: "agent:main:parent",
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:child",
          storePath,
        })?.entry.spawnedBy,
      ).toBeUndefined();
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });

  it("moves a lone alias row to its canonical key", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-single-alias-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveStorePath(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "legacy", updatedAt: 10 },
        env,
        sessionKey: "agent:main:main",
        storePath,
      });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env }).path,
      });
      database.db
        .prepare(
          `UPDATE session_nodes
             SET entry_json = 'not-json', archived_at = 30, category = 'investigation',
                 icon = 'archive', label = 'Recovered metadata', last_activity_at = 29,
                 last_interaction_at = 28, last_read_at = 27, parent_session_key = 'agent:main:parent',
                 pinned_at = 26, spawned_by = 'agent:main:controller', status = 'failed'
           WHERE session_key = ?`,
        )
        .run("agent:main:main");
      database.db
        .prepare(
          `INSERT INTO conversations (
             conversation_id, channel, account_id, kind, peer_id, delivery_target,
             thread_id, created_at, updated_at
           ) VALUES (?, 'matrix', 'work', 'group', ?, ?, 'thread-root', 10, 10)`,
        )
        .run("conv-repair", "!Recovered:example.org", "!Recovered:example.org");
      database.db
        .prepare(
          `UPDATE session_windows
             SET agent_harness_id = 'codex', chat_type = 'group', ended_at = 24,
                 model = 'gpt-5.4', model_provider = 'openai',
                 previous_session_id = 'previous-generation',
                 primary_conversation_id = 'conv-repair', started_at = 23
           WHERE session_id = 'legacy'`,
        )
        .run();

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:main",
          storePath,
        }),
      ).toBeUndefined();
      expect(
        database.db
          .prepare("SELECT count(*) AS count FROM session_nodes WHERE session_key = ?")
          .get("agent:main:main"),
      ).toEqual({ count: 0 });
      const repaired = loadExactSessionEntryReadOnly({
        agentId: "main",
        env,
        sessionKey: "agent:main:work",
        storePath,
      })?.entry;
      expect(repaired).toMatchObject({
        archivedAt: 30,
        category: "investigation",
        chatType: "group",
        endedAt: 24,
        icon: "archive",
        label: "Recovered metadata",
        lastActivityAt: 29,
        lastInteractionAt: 28,
        lastReadAt: 27,
        parentSessionKey: "agent:main:parent",
        pinnedAt: 26,
        previousSessionId: "previous-generation",
        model: "gpt-5.4",
        modelProvider: "openai",
        agentHarnessId: "codex",
        sessionId: "legacy",
        spawnedBy: "agent:main:controller",
        startedAt: 23,
        status: "failed",
      });
      expect(getSessionProjectedTitle(repaired)).toBe("Recovered metadata");
      expect(deliveryContextFromSession(repaired)).toEqual({
        accountId: "work",
        channel: "matrix",
        threadId: "thread-root",
        to: "!Recovered:example.org",
      });
      expect(() =>
        replaceSessionEntrySync(
          { agentId: "main", env, sessionKey: "agent:main:main", storePath },
          { sessionId: "recreated-alias", updatedAt: 20 },
        ),
      ).toThrow("openclaw doctor --fix");
    });
  });

  it("moves a lone canonical row out of the wrong agent database", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-wrong-store-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveStorePath(storeTemplate, { agentId: "main", env });
      const opsStore = resolveStorePath(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "ops",
        entry: {
          parentSessionKey: "main",
          sessionId: "misplaced",
          spawnedBy: "controller",
          updatedAt: 10,
        },
        env,
        eventText: "misplaced history",
        sessionKey: "agent:main:misplaced",
        storePath: opsStore,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:misplaced",
          storePath: mainStore,
        })?.entry,
      ).toMatchObject({
        parentSessionKey: "agent:main:work",
        sessionId: "misplaced",
        spawnedBy: "agent:main:controller",
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "ops",
          env,
          sessionKey: "agent:main:misplaced",
          storePath: opsStore,
        }),
      ).toBeUndefined();
      expect(() =>
        replaceSessionEntrySync(
          { agentId: "main", env, sessionKey: "agent:main:main", storePath: mainStore },
          { sessionId: "new-destination-alias", updatedAt: 20 },
        ),
      ).toThrow("openclaw doctor --fix");
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "misplaced",
          sessionKey: "agent:main:misplaced",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "misplaced history" }),
        }),
      ]);
    });
  });

  it("refreshes the title when a loser transcript fills an empty winner generation", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-title-refresh-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveStorePath(storeTemplate, { agentId: "main", env });
      const opsStore = resolveStorePath(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { mainKey: "shared", store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:shared", storePath: mainStore },
        { sessionId: "shared-session", updatedAt: 20 },
      );
      const mainDatabase = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(mainStore, { agentId: "main", env }).path,
      });
      mainDatabase.db
        .prepare(
          "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES ('shared-session', 0, 'run-1', '{}', 20)",
        )
        .run();
      insertLegacySession({
        agentId: "ops",
        entry: { sessionId: "shared-session", updatedAt: 10 },
        env,
        eventText: "loser transcript title",
        sessionKey: "agent:main:main ",
        storePath: opsStore,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(mainStore, { agentId: "main", env }).path,
      });
      expect(
        database.db
          .prepare("SELECT display_name FROM session_nodes WHERE session_key = ?")
          .get("agent:main:shared"),
      ).toEqual({ display_name: "loser transcript title" });
    });
  });

  it("keeps canonical destination history when cross-store timestamps tie", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-tied-stores-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveStorePath(storeTemplate, { agentId: "main", env });
      const opsStore = resolveStorePath(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { mainKey: "shared", store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "canonical", updatedAt: 10 },
        env,
        eventText: "canonical history",
        sessionKey: "agent:main:shared",
        storePath: mainStore,
      });
      insertLegacySession({
        agentId: "ops",
        entry: { sessionId: "wrong-store", updatedAt: 10 },
        env,
        eventText: "wrong-store history",
        sessionKey: "agent:main:main ",
        storePath: opsStore,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        })?.entry,
      ).toMatchObject({ sessionId: "canonical", updatedAt: 10 });
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "canonical",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "canonical history" }),
        }),
      ]);
    });
  });
});
