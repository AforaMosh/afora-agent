import fs from "node:fs";
import path from "node:path";
import { resolvePreferredAforaTmpDir } from "afora-agent/plugin-sdk/file-access-runtime";

export function useReefTempDirs(registerCleanup: (cleanup: () => void) => unknown): {
  make(prefix: string): string;
} {
  const directories = new Set<string>();
  registerCleanup(() => {
    for (const directory of directories) {
      fs.rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
    }
    directories.clear();
  });
  return {
    make(prefix: string): string {
      const directory = fs.mkdtempSync(path.join(resolvePreferredAforaTmpDir(), prefix));
      directories.add(directory);
      return directory;
    },
  };
}
