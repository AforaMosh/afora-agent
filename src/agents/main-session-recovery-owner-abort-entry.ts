import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { mergeRestartRecoveryTerminalRunIds } from "../config/sessions/restart-recovery-state.js";
import type { MainSessionRecoveryOwnerClaim } from "./main-session-recovery-state.js";

export function ownsMainSessionRecoveryForegroundClaim(
  entry: SessionEntry,
  claim: MainSessionRecoveryOwnerClaim,
): boolean {
  const state = entry.mainRestartRecovery;
  return (
    entry.sessionId === claim.sessionId &&
    state?.cycleId === claim.cycleId &&
    state.foregroundClaims?.lifecycleGeneration === claim.lifecycleGeneration &&
    state.foregroundClaims.tokens.includes(claim.claimId)
  );
}

export function abortMainSessionRecoveryOwnerEntry(params: {
  claim: MainSessionRecoveryOwnerClaim;
  entry: SessionEntry;
  now: number;
  runId?: string;
}): boolean {
  const state = params.entry.mainRestartRecovery;
  const claims = state?.foregroundClaims;
  if (!state || !claims || !ownsMainSessionRecoveryForegroundClaim(params.entry, params.claim)) {
    return false;
  }

  const tokens = claims.tokens.filter((token) => token !== params.claim.claimId);
  const ownedRunId = claims.runIdsByClaimId?.[params.claim.claimId];
  const runIdsByClaimId = Object.fromEntries(
    Object.entries(claims.runIdsByClaimId ?? {}).filter(
      ([token]) => token !== params.claim.claimId,
    ),
  );
  const runId =
    normalizeOptionalString(params.runId) ??
    normalizeOptionalString(params.claim.runId) ??
    normalizeOptionalString(ownedRunId);
  const terminalRunIds =
    tokens.length === 0
      ? [
          ...(params.entry.restartRecoveryRuns?.map((run) => run.runId) ?? []),
          ...(runId ? [runId] : []),
        ]
      : runId
        ? [runId]
        : [];
  if (terminalRunIds.length > 0) {
    params.entry.restartRecoveryTerminalRunIds = mergeRestartRecoveryTerminalRunIds(
      params.entry.restartRecoveryTerminalRunIds,
      terminalRunIds,
    );
  }

  if (tokens.length > 0) {
    params.entry.mainRestartRecovery = {
      ...state,
      revision: state.revision + 1,
      foregroundClaims: {
        lifecycleGeneration: claims.lifecycleGeneration,
        tokens,
        ...(Object.keys(runIdsByClaimId).length > 0 ? { runIdsByClaimId } : {}),
      },
    };
    if (runId) {
      const remainingRuns = params.entry.restartRecoveryRuns?.filter(
        (run) =>
          run.lifecycleGeneration !== params.claim.lifecycleGeneration || run.runId !== runId,
      );
      params.entry.restartRecoveryRuns = remainingRuns?.length ? remainingRuns : undefined;
    }
    return true;
  }

  params.entry.status = "killed";
  params.entry.abortedLastRun = true;
  params.entry.lifecycleRunId = runId;
  params.entry.endedAt = params.now;
  params.entry.runtimeMs = Math.max(0, params.now - (params.entry.startedAt ?? params.now));
  params.entry.updatedAt = params.now;
  params.entry.restartRecoveryRuns = undefined;
  params.entry.mainRestartRecovery = undefined;
  return true;
}
