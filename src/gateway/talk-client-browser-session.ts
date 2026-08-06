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
import {
  bindInternalRealtimeVoiceBrowserSessionTerminal,
  type InternalRealtimeVoiceBrowserSessionCreateRequest,
} from "../talk/provider-internal.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { assertValidParams } from "./server-methods/validation.js";
import * as browserAllocations from "./talk-client-browser-allocations.js";
type PrepareAllocation = typeof browserAllocations.prepareBrowserAllocation;
type BrowserAllocation = Parameters<PrepareAllocation>[0];
type PreparedBrowserAllocation = Awaited<ReturnType<PrepareAllocation>>;
type BrowserTerminal = Parameters<typeof browserAllocations.terminateBrowserAllocation>[1];
type ClientConfig = { config: Parameters<typeof closeClientVoiceSession>[0]["config"] };
type PrepareForClient = Omit<BrowserAllocation, "claimDurable" | "closeDurable"> &
  ClientConfig & {
    expectedBrowserAllocationId?: string;
    usesBrowserAllocations: boolean;
  };
type PrepareTerminalForClient = Omit<PrepareForClient, "durableState">;
type CloseForClient = Parameters<typeof browserAllocations.closeBrowserAllocation>[0] &
  ClientConfig;
const LEGACY_VOICE_BINDING_TTL_MS = 6 * 60 * 60_000;
const legacyVoiceSessionByClient = new Map<string, { voiceSessionId: string; expiresAt: number }>();
const legacyVoiceBindingKey = (connId: string, sessionKey: string) => `${connId}\0${sessionKey}`;

export const acquireBrowserCreationLease = browserAllocations.acquireBrowserCreationLease;

function pruneLegacyVoiceBindings(now: number): void {
  for (const [key, binding] of legacyVoiceSessionByClient) {
    if (binding.expiresAt <= now) {
      legacyVoiceSessionByClient.delete(key);
    }
  }
}

export function resolveLegacyVoiceBinding(
  connId: string,
  sessionKey: string,
  now = Date.now(),
): string | undefined {
  pruneLegacyVoiceBindings(now);
  return legacyVoiceSessionByClient.get(legacyVoiceBindingKey(connId, sessionKey))?.voiceSessionId;
}

export function recordLegacyVoiceBinding(
  connId: string,
  sessionKey: string,
  voiceSessionId: string,
  now = Date.now(),
): void {
  pruneLegacyVoiceBindings(now);
  legacyVoiceSessionByClient.set(legacyVoiceBindingKey(connId, sessionKey), {
    voiceSessionId,
    expiresAt: now + LEGACY_VOICE_BINDING_TTL_MS,
  });
}

export function clearLegacyVoiceBinding(
  connId: string,
  sessionKey: string,
  voiceSessionId: string,
): void {
  const key = legacyVoiceBindingKey(connId, sessionKey);
  if (legacyVoiceSessionByClient.get(key)?.voiceSessionId === voiceSessionId) {
    legacyVoiceSessionByClient.delete(key);
  }
}

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
  const browserAllocationId = runtime.allocationId;
  return await browserAllocations.prepareBrowserAllocation({
    ...runtime,
    ...(!usesBrowserAllocations ? { legacyAutoCommit: true as const } : {}),
    claimDurable: () =>
      claimClientVoiceBrowserAllocation({
        ...runtime,
        browserAllocationId,
        expectedBrowserAllocationId,
      }),
    closeDurable: () => closeClientVoiceSession({ ...runtime, browserAllocationId, config }),
  });
}

export function bindBrowserSessionTerminal(
  request: InternalRealtimeVoiceBrowserSessionCreateRequest,
  onTerminal?: () => void,
) {
  let active: PreparedBrowserAllocation | undefined;
  let terminal: BrowserTerminal | undefined;
  bindInternalRealtimeVoiceBrowserSessionTerminal(request, (outcome) => {
    if (!terminal) {
      terminal = outcome;
      onTerminal?.();
      if (active) {
        browserAllocations.terminateBrowserAllocation(active, outcome);
      }
    }
  });
  const prepare = async (params: PrepareForClient) => {
    const allocation = await prepareBrowserAllocationForClient(params);
    active = allocation;
    if (terminal) {
      browserAllocations.terminateBrowserAllocation(allocation, terminal);
    }
    if (!params.usesBrowserAllocations) {
      const result = browserAllocations.commitBrowserAllocation(allocation);
      if (result.state === "terminal") {
        await browserAllocations.closeBrowserAllocation(allocation);
        throw new Error(
          result.terminal.message ?? "Realtime provider session ended during startup",
        );
      }
    }
    return allocation;
  };
  return {
    prepare,
    prepareTerminal: (params?: PrepareTerminalForClient) => {
      const outcome = terminal;
      if (!outcome) {
        return undefined;
      }
      if (!params) {
        return Promise.reject(
          new Error(outcome.message ?? "Realtime provider session ended during startup"),
        );
      }
      return prepare({ ...params, durableState: "ephemeral" }).then((allocation) => ({
        voiceSessionId: allocation.voiceSessionId,
        allocationId: allocation.allocationId,
        terminal: outcome,
      }));
    },
    outcome: () => terminal,
  };
}

export async function closeBrowserAllocationForClient(params: CloseForClient): Promise<void> {
  const { config, ...allocation } = params;
  const result = await browserAllocations.closeBrowserAllocation(allocation);
  if (result === "settled") {
    return;
  }
  const browserAllocationId = result === "ownerless-exact" ? allocation.allocationId : undefined;
  await closeClientVoiceSession({ ...allocation, browserAllocationId, config });
}
