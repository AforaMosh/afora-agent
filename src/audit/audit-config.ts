/** Resolves whether the metadata-only audit ledger records new events. */
import type { AforaConfig } from "../config/types.afora.js";

export type AuditMessageMode = "off" | "direct" | "all";

/**
 * The ledger is on by default: an audit trail enabled only after an incident
 * cannot explain the incident. `logging.audit.enabled: false` stops new event inserts after
 * restart; audit queries still serve retained rows until they expire.
 */
export function isAuditLedgerEnabled(cfg: AforaConfig | undefined): boolean {
  return cfg?.logging?.audit?.enabled !== false;
}

/** Execution identity is retained only after an explicit startup-scoped opt-in. */
export function isExecutionIdentityCollectionEnabled(cfg: AforaConfig | undefined): boolean {
  return isAuditLedgerEnabled(cfg) && cfg?.logging?.audit?.executionIdentity === true;
}

/** Message metadata remains an explicit opt-in inside the default-on ledger. */
export function resolveAuditMessageMode(cfg: AforaConfig | undefined): AuditMessageMode {
  return cfg?.logging?.audit?.messages ?? "off";
}
