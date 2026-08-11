// Google test temp directories are owned by the Vitest lifecycle that creates them.
import fs from "node:fs";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

type RegisterTempDirCleanup = (cleanup: () => void) => unknown;

export function useAutoCleanupTempDirTracker(registerCleanup: RegisterTempDirCleanup) {
  const dirs = new Set<string>();
  registerCleanup(() => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dirs.clear();
  });
  return {
    make(prefix: string): string {
      // openclaw-temp-dir: allow package-local tracker registers cleanup before returning.
      const dir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), prefix));
      dirs.add(dir);
      return dir;
    },
  };
}
