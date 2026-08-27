// Read-only device pairing snapshots avoid joining the shared-state writer lifecycle.
import { withExistingAforaStateDatabaseReadOnly } from "../state/afora-state-db-readonly.js";
import {
  readDevicePairingStoreStateFromDatabase,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";

/** Load pairing state without creating or migrating the shared state database. */
export function loadDevicePairingStoreStateReadOnly(baseDir?: string): DevicePairingStoreState {
  const options = baseDir ? { env: { ...process.env, AFORA_STATE_DIR: baseDir } } : {};
  return (
    withExistingAforaStateDatabaseReadOnly(
      ({ db }) => readDevicePairingStoreStateFromDatabase(db),
      options,
    ) ?? { pendingById: {}, pairedByDeviceId: {} }
  );
}
