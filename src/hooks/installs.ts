import { expectDefined } from "@afora/normalization-core";
// Hook install record helpers read and write installed hook metadata.
import type { HookInstallRecord } from "../config/types.hooks.js";
import type { AforaConfig } from "../config/types.afora.js";
import { readConfigMachineState, updateConfigMachineState } from "../state/config-machine-state.js";
import type { AforaStateDatabaseOptions } from "../state/afora-state-db.js";

/** Install record plus the hook pack id being updated in config. */
export type HookInstallUpdate = HookInstallRecord & { hookId: string };

/** Read canonical hook install records from machine state. */
export function readHookInstalls(
  options: AforaStateDatabaseOptions = {},
): Record<string, HookInstallRecord> {
  return (
    readConfigMachineState<Record<string, HookInstallRecord>>("hooks.internal.installs", options) ??
    {}
  );
}

/** Persist one hook install record in machine state. */
export function recordHookInstall(
  cfg: AforaConfig,
  update: HookInstallUpdate,
  options: AforaStateDatabaseOptions = {},
): AforaConfig {
  const { hookId, ...record } = update;
  updateConfigMachineState<Record<string, HookInstallRecord>>(
    "hooks.internal.installs",
    (current) => {
      const installs = {
        ...current,
        [hookId]: {
          ...current?.[hookId],
          ...record,
          installedAt: record.installedAt ?? new Date().toISOString(),
        },
      };
      installs[hookId] = expectDefined(installs[hookId], "installs entry at hook id");
      return installs;
    },
    options,
  );
  return cfg;
}
