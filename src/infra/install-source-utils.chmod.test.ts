import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const resolvePreferredAforaTmpDirMock = vi.hoisted(() => vi.fn());

vi.mock("./tmp-afora-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tmp-afora-dir.js")>();
  return {
    ...actual,
    resolvePreferredAforaTmpDir: resolvePreferredAforaTmpDirMock,
  };
});

import { withInstallWorkspace } from "./install-source-utils.js";

describe("withInstallWorkspace private root", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.runIf(process.platform !== "win32")(
    "preserves parent temp root permissions when using private Afora temp root",
    async () => {
      const mockParentRoot = tempDirs.make("afora-chmod-test-");
      const mockAforaDir = path.join(mockParentRoot, "afora");

      await fs.mkdir(mockAforaDir, { recursive: true });
      await fs.chmod(mockParentRoot, 0o1777);
      const canonicalAforaDir = await fs.realpath(mockAforaDir);

      resolvePreferredAforaTmpDirMock.mockReturnValue(mockAforaDir);

      let observedDir = "";
      const value = await withInstallWorkspace("afora-test-", async (tmpDir) => {
        observedDir = tmpDir;
        expect(path.dirname(tmpDir)).toBe(canonicalAforaDir);
        await fs.writeFile(path.join(tmpDir, "marker.txt"), "ok");
        return "done";
      });

      expect(value).toBe("done");

      await expect(
        fs.stat(observedDir).then(
          () => true,
          () => false,
        ),
      ).resolves.toBe(false);

      const privateRootStat = await fs.stat(mockAforaDir);
      expect(privateRootStat.mode & 0o7777).toBe(0o700);

      const parentStat = await fs.stat(mockParentRoot);
      expect(parentStat.mode & 0o7777).toBe(0o1777);
    },
  );
});
