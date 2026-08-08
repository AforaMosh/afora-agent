import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isIngressAdoptionLostError } from "../../channels/message/ingress-drain.js";
import { logVerbose } from "../../globals.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { type ReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { buildChannelSourceTurnId } from "./source-turn-id.js";

/** Resolves the route-scoped source id, including prepared internal turns without a channel stamp. */
export function resolveSteeredTurnId(params: {
  followupRun: FollowupRun;
  restartRecoverySourceTurnId: string | undefined;
  runId: unknown;
  sessionCtx: TemplateContext;
  sessionKey: string | undefined;
}): string {
  return expectDefined(
    params.restartRecoverySourceTurnId ??
      buildChannelSourceTurnId({
        provider:
          params.followupRun.originatingChannel ??
          params.followupRun.run.messageProvider ??
          params.sessionCtx.Provider,
        accountId:
          params.followupRun.originatingAccountId ??
          params.followupRun.run.agentAccountId ??
          params.sessionCtx.AccountId,
        conversationId:
          params.followupRun.originatingTo ??
          params.followupRun.originatingChatId ??
          params.sessionKey ??
          params.followupRun.run.sessionKey,
        messageId:
          params.followupRun.messageId ??
          params.sessionCtx.MessageSidFull ??
          params.sessionCtx.MessageSid,
      }) ??
      normalizeOptionalString(params.runId),
    "steered turn id",
  );
}

export async function finalizeAcceptedSteer(params: {
  activeReplyOperation: ReplyOperation | undefined;
  abortKey: string | undefined;
  cleanupTyping: () => void;
  errorMessage: string | undefined;
  onAdopted: (() => void | Promise<void>) | undefined;
  replyOperationRunState: ReplyOperationRunState | undefined;
  steerSessionId: string;
  transcriptCommit: "unconfirmed" | undefined;
}): Promise<"continue" | "stop"> {
  const transcriptCommitUnconfirmed = params.transcriptCommit === "unconfirmed";
  if (params.replyOperationRunState) {
    // Harness acceptance has transferred this turn to the active session.
    // Replay after an uncertain receipt could run the same user side effects twice.
    params.replyOperationRunState.admission = { status: "accepted", mode: "steer" };
  }
  params.activeReplyOperation?.recordActivity();
  const abortActiveRun = () => {
    if (params.abortKey) {
      replyRunRegistry.abort(params.abortKey);
    }
  };
  if (transcriptCommitUnconfirmed) {
    // The runtime accepted this message, but exact cancellation could not find it.
    // Preserve at-most-once delivery: abort the uncertain owner without replaying.
    abortActiveRun();
    logVerbose(
      `queue: active session ${params.steerSessionId} accepted steering without transcript confirmation; aborting active run without ingress replay (${params.errorMessage ?? "unknown receipt failure"})`,
    );
  }
  const adoptionBoundary = transcriptCommitUnconfirmed ? "harness acceptance" : "transcript commit";
  try {
    await params.onAdopted?.();
  } catch (error) {
    if (isIngressAdoptionLostError(error)) {
      abortActiveRun();
      logVerbose(
        `queue: active session ${params.steerSessionId} adoption lost after ${adoptionBoundary} (${error.code}); aborting steered turn without ingress replay`,
      );
      params.cleanupTyping();
      return "stop";
    }
    logVerbose(
      `queue: active session ${params.steerSessionId} adoption finalizer failed after ${adoptionBoundary}: ${String(error)}`,
    );
  }
  if (transcriptCommitUnconfirmed) {
    params.cleanupTyping();
    return "stop";
  }
  return "continue";
}
