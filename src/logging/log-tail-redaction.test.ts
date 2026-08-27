// Log tail redaction tests cover scrubbing sensitive data from tailed logs.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readConfiguredLogTail } from "./log-tail.js";

const tempDirs = createTempDirTracker();

afterEach(async () => {
  setLoggerOverride(null);
  resetLogger();
  tempDirs.cleanup();
});

describe("readConfiguredLogTail redaction", () => {
  it("redacts raw auth headers before returning log lines", async () => {
    const dir = tempDirs.make("afora-log-tail-redaction-");
    const logFile = path.join(dir, "afora.log");
    const configFile = path.join(dir, "afora.json");
    const basicSecret = "c2VjcmV0OnBhc3M=";
    const aforaToken = "supersecretgatewaytoken1234567890";
    const pomeriumJwt = "eyJheaderabcd.eyJpayloadabcd.signatureabcd123456";

    await fs.writeFile(
      configFile,
      JSON.stringify({ logging: { redactSensitive: "tools" } }),
      "utf8",
    );
    await fs.writeFile(
      logFile,
      [
        `Authorization: Basic ${basicSecret}`,
        `X-Afora-Token: ${aforaToken}`,
        `x-pomerium-jwt-assertion: ${pomeriumJwt}`,
        "normal diagnostic line",
      ].join("\n"),
      "utf8",
    );
    setLoggerOverride({ file: logFile });

    const payload = await withEnvAsync(
      { AFORA_CONFIG_PATH: configFile },
      async () => await readConfiguredLogTail({ limit: 10 }),
    );
    const text = payload.lines.join("\n");

    expect(text).toContain("Authorization: Basic ***");
    expect(text).toContain("X-Afora-Token: supers…7890");
    expect(text).toContain("x-pomerium-jwt-assertion: eyJhea…3456");
    expect(text).toContain("normal diagnostic line");
    expect(text).not.toContain(basicSecret);
    expect(text).not.toContain(aforaToken);
    expect(text).not.toContain(pomeriumJwt);
  });
});
