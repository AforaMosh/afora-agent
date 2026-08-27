import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAforaStateDatabaseForTest } from "../state/afora-state-db.js";
import { readHookInstalls, recordHookInstall } from "./installs.js";

afterEach(() => {
  closeAforaStateDatabaseForTest();
});

describe("hook install machine state", () => {
  it("merges independently recorded hook packs", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "afora-hook-installs-"));
    const options = { env: { ...process.env, AFORA_STATE_DIR: stateDir } };

    recordHookInstall({}, { hookId: "alpha", source: "npm" }, options);
    recordHookInstall({}, { hookId: "beta", source: "path" }, options);

    expect(readHookInstalls(options)).toMatchObject({
      alpha: { source: "npm" },
      beta: { source: "path" },
    });
  });
});
