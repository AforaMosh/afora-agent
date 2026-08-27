// Webhooks API module exposes the plugin public contract.
export {
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  normalizeWebhookPath,
  readJsonWebhookBodyOrReject,
  resolveRequestClientIp,
  resolveWebhookTargetWithAuthOrReject,
  resolveWebhookTargetWithAuthOrRejectSync,
  withResolvedWebhookRequestPipeline,
  WEBHOOK_IN_FLIGHT_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  type WebhookInFlightLimiter,
} from "afora-agent/plugin-sdk/webhook-ingress";
export type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
