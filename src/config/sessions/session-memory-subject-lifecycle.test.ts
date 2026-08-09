import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createMemoryIdentityBindingThroughApprovedPairing } from "../../pairing/memory-identity-approval.test-support.js";
import { memoryIdentityLifecycle } from "../../state/memory-identity.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  copySessionOwnedStateForCanonicalRepair,
  forkSessionAtMessage,
  forkSessionFromParentTranscript,
  loadSessionEntry,
  resetSessionEntryLifecycle,
  rewindSessionToMessage,
  upsertSessionEntry,
  type SessionAccessScope,
} from "./session-accessor.js";
import { importSqliteSessionRows } from "./session-accessor.sqlite.js";
import {
  readCurrentSessionMemorySubject,
  readCurrentSessionMemorySubjectAuthority,
} from "./session-memory-subject-access.js";
import {
  prepareChannelBindingSessionMemorySubjectSeed,
  prepareExplicitSessionMemorySubjectSeed,
  prepareSessionMemorySubjectLineageSeed,
  SessionMemorySubjectReboundError,
  type TrustedSessionMemorySubjectSnapshot,
} from "./session-memory-subject.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirectories = useAutoCleanupTempDirTracker(afterEach);

const { ensureEnterpriseMemoryPrincipal, revokeMemoryIdentityBinding } = memoryIdentityLifecycle;

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function createPaths() {
  const root = tempDirectories.make("openclaw-session-memory-subject-lifecycle-");
  return {
    stateOptions: { env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") } },
    storePath: (agentId: string) => path.join(root, "agents", agentId, "sessions", "sessions.json"),
  };
}

function readRequiredSubject(scope: SessionAccessScope): TrustedSessionMemorySubjectSnapshot {
  const snapshot = readCurrentSessionMemorySubject(scope);
  if (!snapshot) {
    throw new Error(`expected a persisted memory subject for ${scope.sessionKey}`);
  }
  return snapshot;
}

function expectExactSubjectLineage(
  source: TrustedSessionMemorySubjectSnapshot,
  descendant: TrustedSessionMemorySubjectSnapshot,
) {
  expect(descendant.subjectRevision).toBe(source.subjectRevision);
  expect(descendant.subject).toEqual(source.subject);
  expect(descendant.creationBindingId).toBe(source.creationBindingId);
  expect(descendant.canonicalConversationRef).toBe(source.canonicalConversationRef);
}

async function appendActiveMessagePath(params: {
  scope: Required<Pick<SessionAccessScope, "agentId" | "sessionKey" | "storePath">> & {
    sessionId: string;
  };
}) {
  await appendTranscriptEvent(params.scope, {
    type: "session",
    id: params.scope.sessionId,
    version: 3,
    timestamp: "2026-08-09T00:00:00.000Z",
  });
  await appendTranscriptMessage(params.scope, {
    eventId: "user-1",
    message: { role: "user", content: "first prompt" },
    now: Date.parse("2026-08-09T00:00:01.000Z"),
    parentId: null,
  });
  await appendTranscriptMessage(params.scope, {
    eventId: "assistant-1",
    message: { role: "assistant", content: "first response" },
    now: Date.parse("2026-08-09T00:00:02.000Z"),
    parentId: "user-1",
  });
  await appendTranscriptMessage(params.scope, {
    eventId: "user-2",
    message: { role: "user", content: "second prompt" },
    now: Date.parse("2026-08-09T00:00:03.000Z"),
    parentId: "assistant-1",
  });
  await appendTranscriptMessage(params.scope, {
    eventId: "assistant-2",
    message: { role: "assistant", content: "second response" },
    now: Date.parse("2026-08-09T00:00:04.000Z"),
    parentId: "user-2",
  });
}

async function createBoundUserSource(params: { name: string }) {
  const paths = createPaths();
  const agentId = "main";
  const storePath = paths.storePath(agentId);
  const stableSenderId = `${params.name}-sender`;
  const principal = ensureEnterpriseMemoryPrincipal({
    issuer: "session-memory-subject-lifecycle-test",
    stableSubjectId: `${params.name}-principal`,
    now: 100,
    options: paths.stateOptions,
  });
  const binding = await createMemoryIdentityBindingThroughApprovedPairing({
    channel: "telegram",
    accountId: "default",
    stableSenderId,
    principalId: principal.principalId,
    now: 100,
    options: paths.stateOptions,
  });
  const scope = {
    agentId,
    sessionId: `${params.name}-source-session`,
    sessionKey: `agent:${agentId}:${params.name}-source`,
    storePath,
  };
  await upsertSessionEntry(
    scope,
    { sessionId: scope.sessionId, updatedAt: 101 },
    {
      memorySubjectSeed: prepareChannelBindingSessionMemorySubjectSeed({
        channel: "telegram",
        accountId: "default",
        stableSenderId,
        now: 101,
        options: paths.stateOptions,
      }),
    },
  );
  return {
    binding,
    paths,
    sourceScope: scope,
    sourceSubject: readRequiredSubject(scope),
  };
}

type BoundUserSource = Awaited<ReturnType<typeof createBoundUserSource>>;
type BoundUserDescendant = Readonly<{ scope: SessionAccessScope }>;
type BoundUserDescendantCase = Readonly<{
  name: string;
  derive: (source: BoundUserSource) => Promise<BoundUserDescendant>;
}>;

const boundUserDescendantCases: readonly BoundUserDescendantCase[] = [
  {
    name: "reset",
    derive: async ({ sourceScope }) => {
      await resetSessionEntryLifecycle({
        buildNextEntry: () => ({ sessionId: "reset-descendant-session", updatedAt: 110 }),
        storePath: sourceScope.storePath,
        target: { canonicalKey: sourceScope.sessionKey, storeKeys: [sourceScope.sessionKey] },
      });
      return { scope: sourceScope };
    },
  },
  {
    name: "rollover",
    derive: async ({ sourceScope }) => {
      await upsertSessionEntry(sourceScope, {
        sessionId: "rollover-descendant-session",
        updatedAt: 110,
      });
      return { scope: sourceScope };
    },
  },
  {
    name: "fork",
    derive: async ({ sourceScope }) => {
      await appendActiveMessagePath({ scope: sourceScope });
      const childSessionKey = "agent:main:fork-descendant";
      const forked = await forkSessionFromParentTranscript({
        agentId: sourceScope.agentId,
        parentEntry: { sessionId: sourceScope.sessionId, updatedAt: 101 },
        parentSessionKey: sourceScope.sessionKey,
        sessionKey: childSessionKey,
        storePath: sourceScope.storePath,
      });
      if (forked.status !== "created") {
        throw new Error(`expected descendant fork, received ${forked.status}`);
      }
      const scope = {
        agentId: sourceScope.agentId,
        sessionKey: childSessionKey,
        storePath: sourceScope.storePath,
      };
      await upsertSessionEntry(scope, {
        sessionId: forked.transcript.sessionId,
        updatedAt: 111,
      });
      return { scope };
    },
  },
  {
    name: "rewind",
    derive: async ({ sourceScope }) => {
      await appendActiveMessagePath({ scope: sourceScope });
      const rewound = await rewindSessionToMessage({
        agentId: sourceScope.agentId,
        entryId: "user-2",
        sessionKey: sourceScope.sessionKey,
        storePath: sourceScope.storePath,
      });
      if (rewound.status !== "created") {
        throw new Error(`expected descendant rewind, received ${rewound.status}`);
      }
      return { scope: sourceScope };
    },
  },
  {
    name: "recovery",
    derive: async ({ sourceScope }) => {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      return { scope: sourceScope };
    },
  },
  {
    name: "confirmed import",
    derive: async ({ paths, sourceScope, sourceSubject }) => {
      const scope = {
        agentId: sourceScope.agentId,
        sessionKey: "agent:main:confirmed-import-descendant",
        storePath: sourceScope.storePath,
      };
      await importSqliteSessionRows({
        agentId: scope.agentId,
        confirmedMemorySubjectLineage: prepareSessionMemorySubjectLineageSeed(sourceSubject),
        entry: { sessionId: "confirmed-import-descendant-session", updatedAt: 110 },
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
        // Keep the source's shared identity DB in scope for the subsequent
        // authority recheck; imports only receive the already-issued lineage.
        env: paths.stateOptions.env,
      });
      return { scope };
    },
  },
];

describe("session memory subject lifecycle provenance", () => {
  it.each(boundUserDescendantCases)(
    "keeps a channel-bound subject revoked after $name lineage",
    async ({ name, derive }) => {
      const source = await createBoundUserSource({ name: name.replace(/\s+/gu, "-") });
      const descendant = await derive(source);
      const descendantSubject = readRequiredSubject(descendant.scope);

      expectExactSubjectLineage(source.sourceSubject, descendantSubject);
      expect(
        revokeMemoryIdentityBinding({
          bindingId: source.binding.bindingId,
          now: 150,
          revokedBy: "lifecycle-test",
          options: source.paths.stateOptions,
        }),
      ).toBe(true);
      expect(
        readCurrentSessionMemorySubjectAuthority(descendant.scope, source.paths.stateOptions, 151)
          ?.authority,
      ).toEqual({ kind: "denied", reason: "binding-revoked" });
    },
  );

  it("keeps a reset descendant denied after its captured binding expires", async () => {
    const source = await createBoundUserSource({ name: "expiry-reset" });
    await resetSessionEntryLifecycle({
      buildNextEntry: () => ({ sessionId: "expiry-reset-descendant-session", updatedAt: 110 }),
      storePath: source.sourceScope.storePath,
      target: {
        canonicalKey: source.sourceScope.sessionKey,
        storeKeys: [source.sourceScope.sessionKey],
      },
    });
    const descendant = readRequiredSubject(source.sourceScope);
    expectExactSubjectLineage(source.sourceSubject, descendant);

    // Test-only direct expiry mutation proves authority consults the captured
    // binding's current expiry rather than trusting the immutable subject row.
    openOpenClawStateDatabase(source.paths.stateOptions)
      .db.prepare("UPDATE memory_identity_bindings SET expires_at = ? WHERE binding_id = ?")
      .run(150, source.binding.bindingId);

    expect(
      readCurrentSessionMemorySubjectAuthority(source.sourceScope, source.paths.stateOptions, 151)
        ?.authority,
    ).toEqual({ kind: "denied", reason: "binding-revoked" });
  });

  it("copies an exact subject revision through a generic parent transcript fork", async () => {
    const paths = createPaths();
    const storePath = paths.storePath("main");
    const parentScope = {
      agentId: "main",
      sessionId: "generic-parent-session",
      sessionKey: "agent:main:generic-parent",
      storePath,
    };
    const seed = prepareExplicitSessionMemorySubjectSeed({
      kind: "service",
      stableSubjectId: "generic-parent-service",
      now: 100,
      options: paths.stateOptions,
    });
    await upsertSessionEntry(
      parentScope,
      { sessionId: parentScope.sessionId, updatedAt: 100 },
      { memorySubjectSeed: seed },
    );
    await appendActiveMessagePath({ scope: parentScope });
    const parentSubject = readRequiredSubject(parentScope);

    const forked = await forkSessionFromParentTranscript({
      agentId: "main",
      parentEntry: { sessionId: parentScope.sessionId, updatedAt: 100 },
      parentSessionKey: parentScope.sessionKey,
      sessionKey: "agent:main:generic-child",
      storePath,
    });
    if (forked.status !== "created") {
      throw new Error(`expected generic parent fork, received ${forked.status}`);
    }
    const childScope = {
      agentId: "main",
      sessionKey: "agent:main:generic-child",
      storePath,
    };
    // The generic transcript fork intentionally returns before its caller owns
    // the child entry. Materialize that entry before reading its logical subject.
    await upsertSessionEntry(childScope, {
      sessionId: forked.transcript.sessionId,
      updatedAt: 101,
    });
    const childSubject = readRequiredSubject(childScope);

    expect(childSubject.sessionId).toBe(forked.transcript.sessionId);
    expect(childSubject.sessionIdentityRevision).not.toBe(parentSubject.sessionIdentityRevision);
    expectExactSubjectLineage(parentSubject, childSubject);
  });

  it("quarantines private generic fork lineage when the target is shared main", async () => {
    const paths = createPaths();
    const storePath = paths.storePath("main");
    const parentScope = {
      agentId: "main",
      sessionId: "shared-main-fork-parent",
      sessionKey: "agent:main:private-parent",
      storePath,
    };
    await upsertSessionEntry(
      parentScope,
      { sessionId: parentScope.sessionId, updatedAt: 100 },
      {
        memorySubjectSeed: prepareExplicitSessionMemorySubjectSeed({
          kind: "service",
          stableSubjectId: "private-parent-service",
          now: 100,
          options: paths.stateOptions,
        }),
      },
    );
    await appendActiveMessagePath({ scope: parentScope });

    const forked = await forkSessionFromParentTranscript({
      agentId: "main",
      parentEntry: { sessionId: parentScope.sessionId, updatedAt: 100 },
      parentSessionKey: parentScope.sessionKey,
      sessionKey: "agent:main:main",
      storePath,
    });
    if (forked.status !== "created") {
      throw new Error(`expected shared-main fork, received ${forked.status}`);
    }
    const childScope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntry(childScope, {
      chatType: "direct",
      sessionId: forked.transcript.sessionId,
      updatedAt: 101,
    });

    expect(readRequiredSubject(childScope)).toMatchObject({
      sessionId: forked.transcript.sessionId,
      sessionScope: "shared-main",
      subject: { version: 1, kind: "ambiguous", reason: "shared-main" },
    });
  });

  it("copies an exact subject revision into a cross-agent parent fork", async () => {
    const paths = createPaths();
    const sourceStorePath = paths.storePath("source");
    const targetStorePath = paths.storePath("target");
    const parentScope = {
      agentId: "source",
      sessionId: "cross-agent-parent-session",
      sessionKey: "agent:source:cross-agent-parent",
      storePath: sourceStorePath,
    };
    const seed = prepareExplicitSessionMemorySubjectSeed({
      kind: "service",
      stableSubjectId: "cross-agent-parent-service",
      now: 200,
      options: paths.stateOptions,
    });
    await upsertSessionEntry(
      parentScope,
      { sessionId: parentScope.sessionId, updatedAt: 200 },
      { memorySubjectSeed: seed },
    );
    await appendActiveMessagePath({ scope: parentScope });
    const parentSubject = readRequiredSubject(parentScope);

    const forked = await forkSessionFromParentTranscript({
      agentId: "source",
      parentEntry: { sessionId: parentScope.sessionId, updatedAt: 200 },
      parentSessionKey: parentScope.sessionKey,
      sessionKey: "agent:target:cross-agent-child",
      storePath: sourceStorePath,
      targetStorePath,
    });
    if (forked.status !== "created") {
      throw new Error(`expected cross-agent parent fork, received ${forked.status}`);
    }
    const childScope = {
      agentId: "target",
      sessionKey: "agent:target:cross-agent-child",
      storePath: targetStorePath,
    };
    await upsertSessionEntry(childScope, {
      sessionId: forked.transcript.sessionId,
      updatedAt: 201,
    });
    const childSubject = readRequiredSubject(childScope);

    expect(childSubject.sessionId).toBe(forked.transcript.sessionId);
    expectExactSubjectLineage(parentSubject, childSubject);
  });

  it("copies exact lineage through rewind and message-cut fork windows", async () => {
    const paths = createPaths();
    const storePath = paths.storePath("main");
    const rewindScope = {
      agentId: "main",
      sessionId: "rewind-source-session",
      sessionKey: "agent:main:rewind-source",
      storePath,
    };
    const rewindSeed = prepareExplicitSessionMemorySubjectSeed({
      kind: "agent",
      stableSubjectId: "rewind-agent",
      now: 300,
      options: paths.stateOptions,
    });
    await upsertSessionEntry(
      rewindScope,
      { sessionId: rewindScope.sessionId, updatedAt: 300 },
      { memorySubjectSeed: rewindSeed },
    );
    await appendActiveMessagePath({ scope: rewindScope });
    const rewindBefore = readRequiredSubject(rewindScope);

    const rewound = await rewindSessionToMessage({
      agentId: "main",
      entryId: "user-2",
      sessionKey: rewindScope.sessionKey,
      storePath,
    });
    if (rewound.status !== "created") {
      throw new Error(`expected rewind, received ${rewound.status}`);
    }
    const rewoundSubject = readRequiredSubject(rewindScope);
    expect(rewoundSubject.sessionId).toBe(rewound.entry.sessionId);
    expect(rewoundSubject.sessionIdentityRevision).not.toBe(rewindBefore.sessionIdentityRevision);
    expectExactSubjectLineage(rewindBefore, rewoundSubject);

    const forkSourceScope = {
      agentId: "main",
      sessionId: "message-cut-source-session",
      sessionKey: "agent:main:message-cut-source",
      storePath,
    };
    const forkSeed = prepareExplicitSessionMemorySubjectSeed({
      kind: "agent",
      stableSubjectId: "message-cut-agent",
      now: 400,
      options: paths.stateOptions,
    });
    await upsertSessionEntry(
      forkSourceScope,
      { sessionId: forkSourceScope.sessionId, updatedAt: 400 },
      { memorySubjectSeed: forkSeed },
    );
    await appendActiveMessagePath({ scope: forkSourceScope });
    const forkSourceSubject = readRequiredSubject(forkSourceScope);

    const forked = await forkSessionAtMessage({
      agentId: "main",
      entryId: "user-2",
      sessionKey: forkSourceScope.sessionKey,
      storePath,
      targetKey: "agent:main:message-cut-child",
    });
    if (forked.status !== "created") {
      throw new Error(`expected message-cut fork, received ${forked.status}`);
    }
    const forkedSubject = readRequiredSubject({
      agentId: "main",
      sessionKey: forked.key,
      storePath,
    });
    expect(forkedSubject.sessionId).toBe(forked.entry.sessionId);
    expectExactSubjectLineage(forkSourceSubject, forkedSubject);
    expectExactSubjectLineage(forkSourceSubject, readRequiredSubject(forkSourceScope));
  });

  it("keeps the exact subject revision through rollover and reset", async () => {
    const paths = createPaths();
    const storePath = paths.storePath("main");
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:rollover-reset",
      storePath,
    };
    const seed = prepareExplicitSessionMemorySubjectSeed({
      kind: "system",
      stableSubjectId: "rollover-reset-system",
      now: 500,
      options: paths.stateOptions,
    });
    await upsertSessionEntry(
      scope,
      { sessionId: "rollover-before", updatedAt: 500 },
      { memorySubjectSeed: seed },
    );
    const before = readRequiredSubject(scope);

    await upsertSessionEntry(scope, { sessionId: "rollover-after", updatedAt: 501 });
    const rolled = readRequiredSubject(scope);
    expect(loadSessionEntry(scope)).toMatchObject({
      previousSessionId: "rollover-before",
      sessionId: "rollover-after",
    });
    expect(rolled.sessionIdentityRevision).not.toBe(before.sessionIdentityRevision);
    expectExactSubjectLineage(before, rolled);

    await resetSessionEntryLifecycle({
      buildNextEntry: () => ({ sessionId: "reset-after", updatedAt: 502 }),
      storePath,
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    });
    const reset = readRequiredSubject(scope);
    expect(reset.sessionId).toBe("reset-after");
    expect(reset.sessionIdentityRevision).not.toBe(rolled.sessionIdentityRevision);
    expectExactSubjectLineage(before, reset);
  });

  it("recovers the persisted subject and revisions after an agent database reopen", async () => {
    const paths = createPaths();
    const storePath = paths.storePath("main");
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:recovered-session",
      storePath,
    };
    const seed = prepareExplicitSessionMemorySubjectSeed({
      kind: "service",
      stableSubjectId: "recovered-service",
      now: 600,
      options: paths.stateOptions,
    });
    await upsertSessionEntry(
      scope,
      { sessionId: "recovered-session-id", updatedAt: 600 },
      { memorySubjectSeed: seed },
    );
    const before = readRequiredSubject(scope);

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const recovered = readRequiredSubject(scope);
    expect(recovered.sessionId).toBe(before.sessionId);
    expect(recovered.sessionIdentityRevision).toBe(before.sessionIdentityRevision);
    expectExactSubjectLineage(before, recovered);
  });

  it("copies immutable subject provenance exactly through cross-database canonical repair", async () => {
    const paths = createPaths();
    const sourceStorePath = paths.storePath("source");
    const destinationStorePath = paths.storePath("destination");
    const sourceScope = {
      agentId: "source",
      sessionKey: "agent:source:canonical-repair-source",
      storePath: sourceStorePath,
    };
    const destinationScope = {
      agentId: "destination",
      sessionKey: "agent:destination:canonical-repair-target",
      storePath: destinationStorePath,
    };
    const sourceEntry = { sessionId: "canonical-repair-session", updatedAt: 700 };
    const destinationEntry = { ...sourceEntry, updatedAt: 701 };
    const seed = prepareExplicitSessionMemorySubjectSeed({
      kind: "service",
      stableSubjectId: "canonical-repair-service",
      now: 700,
      options: paths.stateOptions,
    });
    await upsertSessionEntry(sourceScope, sourceEntry, { memorySubjectSeed: seed });
    const sourceSubject = readRequiredSubject(sourceScope);
    const sourceDatabase = openOpenClawAgentDatabase({
      agentId: sourceScope.agentId,
      path: resolveSqliteTargetFromSessionStorePath(sourceStorePath, sourceScope).path,
    });
    const sourceRow = sourceDatabase.db
      .prepare(
        "SELECT created_at, subject_revision FROM session_memory_subjects WHERE session_key = ?",
      )
      .get(sourceScope.sessionKey) as { created_at: number; subject_revision: string } | undefined;
    if (!sourceRow) {
      throw new Error("expected source immutable memory subject row");
    }

    // Canonical repair creates its target entry before copying source-owned
    // state. Remove its auto-backfill so the public helper must copy the source
    // row and snapshot, rather than keeping a newly issued destination subject.
    await upsertSessionEntry(destinationScope, destinationEntry);
    const destinationDatabase = openOpenClawAgentDatabase({
      agentId: destinationScope.agentId,
      path: resolveSqliteTargetFromSessionStorePath(destinationStorePath, destinationScope).path,
    });
    destinationDatabase.db
      .prepare("DELETE FROM session_memory_subject_snapshots WHERE session_id = ?")
      .run(sourceEntry.sessionId);
    destinationDatabase.db
      .prepare("DELETE FROM session_memory_subjects WHERE session_key = ?")
      .run(destinationScope.sessionKey);

    copySessionOwnedStateForCanonicalRepair({
      canonicalKey: destinationScope.sessionKey,
      destinationDatabase,
      preferredEntry: sourceEntry,
      preferredSessionKey: sourceScope.sessionKey,
      source: { agentId: sourceScope.agentId, storePath: sourceStorePath },
      sourceEntries: [sourceEntry],
      sourceKeys: [sourceScope.sessionKey],
    });

    const repaired = readRequiredSubject(destinationScope);
    expect(repaired.sessionKey).toBe(destinationScope.sessionKey);
    expect(repaired.sessionIdentityRevision).toBe(sourceSubject.sessionIdentityRevision);
    expectExactSubjectLineage(sourceSubject, repaired);
    expect(
      destinationDatabase.db
        .prepare(
          "SELECT created_at, subject_revision FROM session_memory_subjects WHERE session_key = ?",
        )
        .get(destinationScope.sessionKey),
    ).toEqual({
      created_at: sourceRow.created_at,
      subject_revision: sourceSubject.subjectRevision,
    });
    expect(
      destinationDatabase.db
        .prepare(
          "SELECT session_key, subject_revision, session_identity_revision FROM session_memory_subject_snapshots WHERE session_id = ?",
        )
        .get(sourceEntry.sessionId),
    ).toEqual({
      session_key: destinationScope.sessionKey,
      session_identity_revision: sourceSubject.sessionIdentityRevision,
      subject_revision: sourceSubject.subjectRevision,
    });
  });

  it("rejects a canonical repair when only immutable subject provenance time differs", async () => {
    const paths = createPaths();
    const sourceStorePath = paths.storePath("source");
    const destinationStorePath = paths.storePath("destination");
    const sourceScope = {
      agentId: "source",
      sessionKey: "agent:source:canonical-repair-created-at-source",
      storePath: sourceStorePath,
    };
    const destinationScope = {
      agentId: "destination",
      sessionKey: "agent:destination:canonical-repair-created-at-target",
      storePath: destinationStorePath,
    };
    const sourceEntry = { sessionId: "canonical-repair-created-at-session", updatedAt: 800 };
    const destinationEntry = { ...sourceEntry, updatedAt: 801 };
    const seed = prepareExplicitSessionMemorySubjectSeed({
      kind: "service",
      stableSubjectId: "canonical-repair-created-at-service",
      now: 800,
      options: paths.stateOptions,
    });
    await upsertSessionEntry(sourceScope, sourceEntry, { memorySubjectSeed: seed });
    await upsertSessionEntry(destinationScope, destinationEntry, { memorySubjectSeed: seed });

    const sourceDatabase = openOpenClawAgentDatabase({
      agentId: sourceScope.agentId,
      path: resolveSqliteTargetFromSessionStorePath(sourceStorePath, sourceScope).path,
    });
    const destinationDatabase = openOpenClawAgentDatabase({
      agentId: destinationScope.agentId,
      path: resolveSqliteTargetFromSessionStorePath(destinationStorePath, destinationScope).path,
    });
    type SubjectProvenanceRow = {
      subject_revision: string;
      subject_kind: string;
      principal_id: string | null;
      conversation_principal_id: string | null;
      channel: string | null;
      account_id: string | null;
      ambiguous_reason: string | null;
      creation_evidence_kind: string | null;
      creation_evidence_revision: string | null;
      creation_binding_id: string | null;
      canonical_conversation_ref: string | null;
      created_at: number;
    };
    const selectSubjectProvenanceRow = (database: typeof sourceDatabase, sessionKey: string) =>
      database.db
        .prepare(
          `
            SELECT
              subject_revision,
              subject_kind,
              principal_id,
              conversation_principal_id,
              channel,
              account_id,
              ambiguous_reason,
              creation_evidence_kind,
              creation_evidence_revision,
              creation_binding_id,
              canonical_conversation_ref,
              created_at
            FROM session_memory_subjects
            WHERE session_key = ?
          `,
        )
        .get(sessionKey) as SubjectProvenanceRow | undefined;
    const sourceRow = selectSubjectProvenanceRow(sourceDatabase, sourceScope.sessionKey);
    const destinationRow = selectSubjectProvenanceRow(
      destinationDatabase,
      destinationScope.sessionKey,
    );
    if (!sourceRow || !destinationRow) {
      throw new Error("expected source and destination immutable memory subject rows");
    }
    expect(sourceRow.created_at).toBe(sourceEntry.updatedAt);
    expect(destinationRow).toEqual({ ...sourceRow, created_at: destinationEntry.updatedAt });

    // Keep the subject row but remove its independently generated snapshot, so
    // the repair rejection can only be caused by its differing audit time.
    destinationDatabase.db
      .prepare("DELETE FROM session_memory_subject_snapshots WHERE session_id = ?")
      .run(sourceEntry.sessionId);

    expect(() =>
      copySessionOwnedStateForCanonicalRepair({
        canonicalKey: destinationScope.sessionKey,
        destinationDatabase,
        preferredEntry: sourceEntry,
        preferredSessionKey: sourceScope.sessionKey,
        source: { agentId: sourceScope.agentId, storePath: sourceStorePath },
        sourceEntries: [sourceEntry],
        sourceKeys: [sourceScope.sessionKey],
      }),
    ).toThrow(SessionMemorySubjectReboundError);
  });
});
