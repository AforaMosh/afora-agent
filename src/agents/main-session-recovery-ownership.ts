import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../config/sessions.js";
import type {
  MainSessionRecoveryOwnerClaim,
  MainSessionRecoveryRunIdentity,
} from "./main-session-recovery-types.js";

export function ownsMainSessionRecoveryClaim(
  state: MainRestartRecoveryState | undefined,
  claim: { cycleId: string; lifecycleGeneration: string; claimId: string },
): boolean {
  return (
    state?.cycleId === claim.cycleId &&
    state.foregroundClaims?.lifecycleGeneration === claim.lifecycleGeneration &&
    state.foregroundClaims.tokens.includes(claim.claimId)
  );
}

export function matchesMainSessionRecoveryRunIdentity(
  entry: SessionEntry,
  target: MainSessionRecoveryRunIdentity,
): boolean {
  if (entry.sessionId !== target.sessionId) {
    return false;
  }
  if (
    entry.restartRecoveryRuns?.some(
      (run) => run.runId === target.runId && run.lifecycleGeneration === target.lifecycleGeneration,
    )
  ) {
    return true;
  }
  const claims = entry.mainRestartRecovery?.foregroundClaims;
  return Boolean(
    claims?.lifecycleGeneration === target.lifecycleGeneration &&
    claims.tokens.some((claimId) => claims.runIdsByClaimId?.[claimId] === target.runId),
  );
}

export function resolveMainSessionRecoveryForegroundAbort(params: {
  entry: SessionEntry;
  target:
    | { kind: "claim"; claim: MainSessionRecoveryOwnerClaim; runId?: string }
    | ({ kind: "run" } & MainSessionRecoveryRunIdentity);
}):
  | {
      claimIds: string[];
      claims: NonNullable<MainRestartRecoveryState["foregroundClaims"]> | undefined;
      runId?: string;
      state: MainRestartRecoveryState;
    }
  | undefined {
  const state = params.entry.mainRestartRecovery;
  if (!state) {
    return undefined;
  }
  const claims = state.foregroundClaims;
  if (params.target.kind === "claim") {
    const { claim } = params.target;
    if (
      params.entry.sessionId !== claim.sessionId ||
      !claims ||
      !ownsMainSessionRecoveryClaim(state, claim)
    ) {
      return undefined;
    }
    return {
      claimIds: [claim.claimId],
      claims,
      runId:
        normalizeOptionalString(params.target.runId) ??
        normalizeOptionalString(claim.runId) ??
        normalizeOptionalString(claims.runIdsByClaimId?.[claim.claimId]),
      state,
    };
  }
  if (!matchesMainSessionRecoveryRunIdentity(params.entry, params.target)) {
    return undefined;
  }
  const claimIds =
    claims?.lifecycleGeneration === params.target.lifecycleGeneration
      ? claims.tokens.filter((claimId) => claims.runIdsByClaimId?.[claimId] === params.target.runId)
      : [];
  return { claimIds, claims, runId: params.target.runId, state };
}
