// Delivery queue helper tests cover shared SQLite and temp-directory cleanup.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isAforaStateDatabaseOpen,
  openAforaStateDatabase,
} from "../../state/afora-state-db.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

const fixture = installDeliveryQueueTmpDirHooks();
let previousTmpDir = "";

describe("installDeliveryQueueTmpDirHooks", () => {
  it("tracks an open per-case state database", () => {
    previousTmpDir = fixture.tmpDir();
    openAforaStateDatabase({ env: { ...process.env, AFORA_STATE_DIR: previousTmpDir } });

    expect(isAforaStateDatabaseOpen()).toBe(true);
    expect(fs.existsSync(previousTmpDir)).toBe(true);
  });

  it("closes handles and removes the previous case directory", () => {
    expect(isAforaStateDatabaseOpen()).toBe(false);
    expect(fs.existsSync(previousTmpDir)).toBe(false);
  });
});
