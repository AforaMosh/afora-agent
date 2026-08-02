import { validateAgentWaitParams } from "../../../packages/gateway-protocol/src/index.js";
import { waitForAgentJob } from "./agent-job.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const agentWaitHandler: GatewayRequestHandlers["agent.wait"] = async ({
  params,
  respond,
  context,
}) => {
  if (!assertValidParams(params, validateAgentWaitParams, "agent.wait", respond)) {
    return;
  }
  const runId = (params.runId ?? "").trim();
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(0, Math.floor(params.timeoutMs))
      : 30_000;
  // Talk's lifecycle final can precede chat.send's delayed source reply.
  // This opt-in waits for the recorded chat outcome instead of false no-text.
  const activeChatEntry = context.chatAbortControllers.get(runId);
  const hasActiveChatRun = activeChatEntry !== undefined && activeChatEntry.kind !== "agent";
  const preferChatResult = params.awaitChatResult === true || hasActiveChatRun;
  const snapshot = await waitForAgentJob({
    runId,
    timeoutMs,
    ...(preferChatResult ? { source: "chat" } : {}),
  });
  if (!snapshot) {
    const activeRunRegistered = activeChatEntry !== undefined;
    respond(true, {
      runId,
      status: "timeout",
      timeoutPhase: activeRunRegistered ? "gateway_draining" : "queue",
      ...(activeRunRegistered ? {} : { providerStarted: false }),
    });
    return;
  }
  respond(true, {
    runId,
    status: snapshot.status,
    resultText: snapshot.resultText,
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    error: snapshot.error,
    stopReason: snapshot.stopReason,
    livenessState: snapshot.livenessState,
    yielded: snapshot.yielded,
    pendingError: snapshot.pendingError,
    timeoutPhase: snapshot.timeoutPhase,
    providerStarted: snapshot.providerStarted,
  });
};
