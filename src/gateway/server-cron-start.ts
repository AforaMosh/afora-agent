import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import type { GatewayCronReconciliation } from "./server-cron-reconciled.js";
import type { GatewayCronState } from "./server-cron.js";

/** Starts cron without making the surrounding startup or reload transaction wait. */
export function startGatewayCronWithLogging(params: {
  cronState: GatewayCronState;
  cronReconciliation: GatewayCronReconciliation;
  reason: "startup" | "reload";
  config: OpenClawConfig;
  afterStart?: () => Promise<void>;
  onStartError?: (error: unknown) => void;
  logCron: { error: (message: string) => void };
}): void {
  const reconciliation = params.cronReconciliation.arm({
    reason: params.reason,
    config: params.config,
    cronState: params.cronState,
  });
  void runWithGatewayIndependentRootWorkAdmission(async () => {
    try {
      await params.cronState.cron.start();
      await params.afterStart?.();
      await reconciliation.complete();
    } catch (err) {
      params.logCron.error(`failed to start: ${String(err)}`);
      // Recovery callbacks must run before this independent root releases its
      // admission fence; restart and suspension cannot race past this point.
      params.onStartError?.(err);
    }
  }).catch((err: unknown) => params.logCron.error(`failed to enter start root: ${String(err)}`));
}
