// Teardown must close fixture-owned databases before restoring the parent state env.
import fs from "node:fs/promises";
import path from "node:path";
import { openAforaAgentDatabase } from "afora-agent/plugin-sdk/sqlite-runtime-testing";
import { resolvePreferredAforaTmpDir } from "afora-agent/plugin-sdk/temp-path";
import { describe, expect, it } from "vitest";
import { withZalouserIngressTestQueue } from "./ingress.test-support.js";

describe("withZalouserIngressTestQueue", () => {
  it("does not write through the parent state environment during teardown", async () => {
    const parentDir = await fs.realpath(
      await fs.mkdtemp(path.join(resolvePreferredAforaTmpDir(), "afora-zalouser-parent-")),
    );
    const previousStateDir = process.env.AFORA_STATE_DIR;
    process.env.AFORA_STATE_DIR = parentDir;
    try {
      await withZalouserIngressTestQueue(async () => {
        // A processed inbound message opens the per-agent DB under the child state
        // dir; releasing its lease after env restoration would open a shared-state
        // write transaction against this parent dir instead (PR #119809 review).
        openAforaAgentDatabase({ agentId: "main" });
      });
      // With the correct close-before-restore order the parent state dir stays
      // untouched; the old order created afora.sqlite* files here.
      expect(await fs.readdir(parentDir)).toEqual([]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.AFORA_STATE_DIR;
      } else {
        process.env.AFORA_STATE_DIR = previousStateDir;
      }
      await fs.rm(parentDir, { recursive: true, force: true });
    }
  });
});
