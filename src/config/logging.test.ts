// Verifies logging config parsing and file path handling.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDirSync } from "../test-helpers/temp-dir.js";

const mocks = vi.hoisted(() => ({
  createConfigIO: vi.fn().mockReturnValue({
    configPath: "/tmp/afora-dev/afora.json",
  }),
}));

vi.mock("./io.js", () => ({
  createConfigIO: mocks.createConfigIO,
}));

let formatConfigFilePath: typeof import("./logging.js").formatConfigFilePath;
let formatConfigUpdatedMessage: typeof import("./logging.js").formatConfigUpdatedMessage;
let logConfigUpdated: typeof import("./logging.js").logConfigUpdated;

beforeAll(async () => {
  ({ formatConfigFilePath, formatConfigUpdatedMessage, logConfigUpdated } =
    await import("./logging.js"));
});

beforeEach(() => {
  mocks.createConfigIO.mockClear();
});

describe("config logging", () => {
  it("formats the live config path when no explicit path is provided", () => {
    expect(formatConfigFilePath()).toBe("/tmp/afora-dev/afora.json");
  });

  it("logs the live config path when no explicit path is provided", () => {
    const runtime = { log: vi.fn() };
    logConfigUpdated(runtime as never);
    expect(runtime.log).toHaveBeenCalledWith("Updated config: /tmp/afora-dev/afora.json");
  });

  it("formats backup as an indented detail when present", () => {
    withTempDirSync({ prefix: "afora-config-log-" }, (dir) => {
      const configPath = path.join(dir, "afora.json");
      const backupPath = `${configPath}.bak`;
      fs.writeFileSync(backupPath, "{}", "utf8");

      expect(
        formatConfigUpdatedMessage(configPath, {
          backupPath,
        }),
      ).toBe(`Updated config: ${configPath}\n  Backup: ${backupPath}`);
    });
  });
});
