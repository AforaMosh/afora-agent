import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkClientAllocationParams,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveTalkSessionAgentId } from "../talk/agent-target.js";
import {
  claimClientVoiceBrowserAllocation,
  closeClientVoiceSession,
} from "../talk/client-voice-session.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { assertValidParams } from "./server-methods/validation.js";
import * as browserAllocations from "./talk-client-browser-allocations.js";
type PrepareAllocation = typeof browserAllocations.prepareBrowserAllocation;
type BrowserAllocation = Parameters<PrepareAllocation>[0];
type PreparedBrowserAllocation = Awaited<ReturnType<PrepareAllocation>>;
type ClientConfig = { config: Parameters<typeof closeClientVoiceSession>[0]["config"] };
type PrepareForClient = Omit<BrowserAllocation, "claimDurable" | "closeDurable"> &
  ClientConfig & {
    expectedBrowserAllocationId?: string;
    usesBrowserAllocations: boolean;
  };
type CloseForClient = Parameters<typeof browserAllocations.closeBrowserAllocation>[0] &
  ClientConfig;

export const acquireBrowserCreationLease = browserAllocations.acquireBrowserCreationLease;
export const allocateBrowserAllocationId = browserAllocations.allocateBrowserAllocationId;

export async function mutateBrowserAllocationRequest(
  request: Parameters<GatewayRequestHandlers[string]>[0],
  operation: "commit" | "abort",
): Promise<void> {
  const { params, respond, context, client } = request;
  const method = `talk.client.${operation}`;
  if (!assertValidParams(params, validateTalkClientAllocationParams, method, respond)) {
    return;
  }
  const connId = normalizeOptionalString(client?.connId);
  if (!connId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "connection id is required"));
    return;
  }
  const mutate =
    operation === "commit"
      ? browserAllocations.commitBrowserAllocation
      : browserAllocations.abortBrowserAllocation;
  const state = await mutate({
    agentId: resolveTalkSessionAgentId(context.getRuntimeConfig(), params.sessionKey),
    ...params,
    connId,
  });
  respond(true, state, undefined);
}

async function prepareBrowserAllocationForClient(
  params: PrepareForClient,
): Promise<PreparedBrowserAllocation> {
  const { usesBrowserAllocations, config, expectedBrowserAllocationId, ...runtime } = params;
  const allocation = await browserAllocations.prepareBrowserAllocation({
    ...runtime,
    ...(!usesBrowserAllocations ? { legacyAutoCommit: true as const } : {}),
    claimDurable: () =>
      claimClientVoiceBrowserAllocation({
        ...runtime,
        browserAllocationId: runtime.allocationId,
        expectedBrowserAllocationId,
      }),
    closeDurable: () =>
      closeClientVoiceSession({
        ...runtime,
        browserAllocationId: runtime.allocationId,
        config,
      }),
  });
  if (usesBrowserAllocations) {
    return allocation;
  }
  const result = browserAllocations.commitBrowserAllocation(allocation);
  if (result.state === "terminal") {
    await browserAllocations.closeBrowserAllocation(allocation);
    throw new Error(result.terminal.message ?? "Realtime provider session ended during startup");
  }
  return allocation;
}

export async function closeBrowserAllocationForClient(params: CloseForClient): Promise<void> {
  const { config, ...allocation } = params;
  const result = await browserAllocations.closeBrowserAllocation(allocation);
  if (result !== "settled") {
    await closeClientVoiceSession({
      ...allocation,
      ...(result === "ownerless-exact" ? { browserAllocationId: allocation.allocationId } : {}),
      config,
    });
  }
}
