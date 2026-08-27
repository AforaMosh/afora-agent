/**
 * Browser test-support re-exports from shared plugin-sdk test fixtures.
 */
import fs from "node:fs";
import path from "node:path";
import { resolvePreferredAforaTmpDir } from "afora-agent/plugin-sdk/temp-path";

export {
  createCliRuntimeCapture,
  expectGeneratedTokenPersistedToGatewayAuth,
  type CliRuntimeCapture,
} from "afora-agent/plugin-sdk/test-fixtures";
export { createTempHomeEnv } from "afora-agent/plugin-sdk/test-env";
export type { TempHomeEnv } from "afora-agent/plugin-sdk/test-env";
export { isLiveTestEnabled } from "afora-agent/plugin-sdk/test-live";
export type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";

export function useAutoCleanupTempDirTracker(registerCleanup: (cleanup: () => void) => unknown) {
  const dirs = new Set<string>();
  registerCleanup(() => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dirs.clear();
  });
  return {
    make(prefix: string): string {
      const dir = fs.mkdtempSync(path.join(resolvePreferredAforaTmpDir(), prefix));
      dirs.add(dir);
      return dir;
    },
  };
}
