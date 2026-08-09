import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { commitMainSessionRecovery } from "../../agents/main-session-recovery-store.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { readCurrentSessionMemorySubject } from "../../config/sessions/session-memory-subject-access.js";
import { prepareExplicitSessionMemorySubjectSeed } from "../../config/sessions/session-memory-subject.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { AgentSessionPatchBuild } from "./agent-session-patch.js";
import { persistAgentSessionPhase } from "./agent-session-persist.js";
import { createAgentRunSessionMemorySubjectIssuer } from "./session-creation-provenance.js";

const tempDirectories = useAutoCleanupTempDirTracker(afterEach);

function createPatchBuild(sessionId: string, isNewSession = true): AgentSessionPatchBuild {
  return {
    patch: { sessionId, updatedAt: 100 },
    spawnedBy: undefined,
    groupId: undefined,
    groupChannel: undefined,
    groupSpace: undefined,
    freshSessionRotatedSinceLoad: false,
    isNewSession,
    rotatedSessionId: false,
    usableRequestedSessionId: undefined,
    freshness: undefined,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("persistAgentSessionPhase memory subject issuance", () => {
  it("persists a Gateway restart-recovery run with its closed system subject on the canonical key", async () => {
    const root = tempDirectories.make("openclaw-gateway-recovery-memory-subject-");
    const storePath = path.join(root, "agents", "target", "sessions", "sessions.json");
    const canonicalSessionKey = "agent:target:recovery:canonical";
    const requestAlias = "agent:target:recovery:requested";
    const sessionId = "recovery-session";
    const memorySubjectIssuer = createAgentRunSessionMemorySubjectIssuer({
      internal: { autonomousMemorySubject: "gateway-recovery" },
    });
    if (!memorySubjectIssuer) {
      throw new Error("expected a Gateway recovery subject issuer");
    }
    let admittedSessionId = "recovery-run";

    const result = await persistAgentSessionPhase({
      request: { message: "resume", idempotencyKey: "gateway-recovery-call" },
      cfg: {},
      storePath,
      storeKeys: [requestAlias, canonicalSessionKey],
      canonicalSessionKey,
      sessionAgentId: "target",
      mainSessionKey: "agent:target:main",
      creation: { via: "run" },
      memorySubjectIssuer,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      isRestartRecoveryResumeRun: false,
      runId: "recovery-run",
      agentId: "target",
      suppressVisibleSessionEffects: false,
      initialPatchBuild: createPatchBuild(sessionId),
      buildSessionPatch: () => createPatchBuild(sessionId),
      initialSessionPersistedBeforeGatewayAdmission: false,
      initialSupersededSessionId: undefined,
      touchInteraction: false,
      requestedBestEffortDeliver: undefined,
      bestEffortDeliver: false,
      expectedSession: undefined,
      maintenanceConfig: undefined,
      abortForLifecycleRotation: () => false,
      assertGatewayWorkAdmissionAllowed: () => undefined,
      respondToGatewayAdmissionOutcome: () => false,
      updateAdmissionState: (state) => {
        admittedSessionId = state.admittedSessionId;
      },
      getAdmittedSessionId: () => admittedSessionId,
      setCronContinuationClaim: () => undefined,
      setMainRestartRecoveryOwnerLease: () => undefined,
      respond: vi.fn(),
    });

    expect(result?.sessionEntry?.sessionId).toBe(sessionId);
    const snapshot = readCurrentSessionMemorySubject({
      agentId: "target",
      sessionKey: canonicalSessionKey,
      storePath,
    });
    expect(snapshot?.subject).toEqual(
      prepareExplicitSessionMemorySubjectSeed({
        kind: "system",
        stableSubjectId: "gateway-recovery",
      }).subject,
    );
    if (!snapshot) {
      throw new Error("expected the initial recovery session subject");
    }

    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const interrupted = await commitMainSessionRecovery({
      command: { kind: "mark_interrupted", cycleId: "recovery-cycle", now: 200 },
      requireWriteSuccess: true,
      target: { sessionKey: canonicalSessionKey, storePath },
    });
    expect(interrupted.transition).toEqual({ kind: "applied" });
    const reserved = await commitMainSessionRecovery({
      command: {
        kind: "prepare_attempt",
        attempt: 1,
        lifecycleGeneration,
        now: 201,
        observation: { sessionId, cycleId: "recovery-cycle", revision: 1 },
        runId: "recovery-resume-run",
        executionIdentity: { state: "disabled" },
      },
      requireWriteSuccess: true,
      target: { sessionKey: canonicalSessionKey, storePath },
    });
    expect(reserved.transition).toMatchObject({ kind: "reserved" });
    if (!reserved.entry) {
      throw new Error("expected the reserved recovery session entry");
    }

    const resumed = await persistAgentSessionPhase({
      request: {
        message: "resume after Gateway restart",
        idempotencyKey: "gateway-recovery-resume-call",
        expectedExistingSessionId: sessionId,
      },
      cfg: {},
      storePath,
      storeKeys: [requestAlias, canonicalSessionKey],
      entry: reserved.entry,
      canonicalSessionKey,
      sessionAgentId: "target",
      mainSessionKey: "agent:target:main",
      creation: { via: "run" },
      memorySubjectIssuer,
      lifecycleGeneration,
      isRestartRecoveryResumeRun: true,
      runId: "recovery-resume-run",
      agentId: "target",
      suppressVisibleSessionEffects: false,
      initialPatchBuild: createPatchBuild(sessionId, false),
      buildSessionPatch: () => createPatchBuild(sessionId, false),
      initialSessionEntry: reserved.entry,
      initialResolvedSessionId: sessionId,
      initialSessionPersistedBeforeGatewayAdmission: true,
      initialSupersededSessionId: undefined,
      touchInteraction: false,
      requestedBestEffortDeliver: undefined,
      bestEffortDeliver: false,
      expectedSession: { sessionId },
      maintenanceConfig: undefined,
      abortForLifecycleRotation: () => false,
      assertGatewayWorkAdmissionAllowed: () => undefined,
      respondToGatewayAdmissionOutcome: () => false,
      updateAdmissionState: (state) => {
        admittedSessionId = state.admittedSessionId;
      },
      getAdmittedSessionId: () => admittedSessionId,
      setCronContinuationClaim: () => undefined,
      setMainRestartRecoveryOwnerLease: () => undefined,
      respond: vi.fn(),
    });

    expect(resumed?.sessionEntry?.sessionId).toBe(sessionId);
    const resumedSnapshot = readCurrentSessionMemorySubject({
      agentId: "target",
      sessionKey: canonicalSessionKey,
      storePath,
    });
    expect(resumedSnapshot).toMatchObject({
      sessionId: snapshot.sessionId,
      sessionIdentityRevision: snapshot.sessionIdentityRevision,
      subjectRevision: snapshot.subjectRevision,
      subject: snapshot.subject,
    });

    const database = openOpenClawAgentDatabase(
      toDatabaseOptions(
        resolveSqliteScope({
          agentId: "target",
          sessionKey: canonicalSessionKey,
          storePath,
        }),
      ),
    );
    expect(
      database.db
        .prepare("SELECT session_key FROM session_nodes ORDER BY session_key")
        .all()
        .map((row) => (row as { session_key: string }).session_key),
    ).toEqual([canonicalSessionKey]);
  });
});
