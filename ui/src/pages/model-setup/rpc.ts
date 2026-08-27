import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SystemAgentSetupDetectResult,
  SystemAgentSetupVerifyResult,
} from "../../api/types.ts";
import { MODEL_SETUP_DETECT_TIMEOUT_MS, MODEL_SETUP_VERIFY_TIMEOUT_MS } from "./state.ts";

export function detectModelSetup(
  client: GatewayBrowserClient,
  agentId?: string,
  signal?: AbortSignal,
): Promise<SystemAgentSetupDetectResult> {
  return client.request<SystemAgentSetupDetectResult>(
    "afora.setup.detect",
    agentId ? { agentId } : {},
    { timeoutMs: MODEL_SETUP_DETECT_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  );
}

export function verifyModelSetup(
  client: GatewayBrowserClient,
  agentId?: string,
  signal?: AbortSignal,
): Promise<SystemAgentSetupVerifyResult> {
  return client.request<SystemAgentSetupVerifyResult>(
    "afora.setup.verify",
    agentId ? { agentId } : {},
    { timeoutMs: MODEL_SETUP_VERIFY_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  );
}
