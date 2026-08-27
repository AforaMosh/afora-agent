// Tests Afora execution environment construction.
import { describe, expect, it } from "vitest";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  ensureAforaExecMarkerOnProcess,
  markAforaExecEnv,
  AFORA_CLI_ENV_VAR,
} from "./afora-exec-env.js";

const AFORA_CLI_ENV_VALUE = "1";

describe("markAforaExecEnv", () => {
  it("returns a cloned env object with the exec marker set", () => {
    const env = { PATH: "/usr/bin", AFORA_CLI: "0" };
    const marked = markAforaExecEnv(env);

    expect(marked).toEqual({
      PATH: "/usr/bin",
      AFORA_CLI: AFORA_CLI_ENV_VALUE,
    });
    expect(marked).not.toBe(env);
    expect(env.AFORA_CLI).toBe("0");
  });
});

describe("ensureAforaExecMarkerOnProcess", () => {
  it.each([
    {
      name: "mutates and returns the provided process env",
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    },
    {
      name: "overwrites an existing marker on the provided process env",
      env: { PATH: "/usr/bin", [AFORA_CLI_ENV_VAR]: "0" } as NodeJS.ProcessEnv,
    },
  ])("$name", ({ env }) => {
    expect(ensureAforaExecMarkerOnProcess(env)).toBe(env);
    expect(env[AFORA_CLI_ENV_VAR]).toBe(AFORA_CLI_ENV_VALUE);
  });

  it("defaults to mutating process.env when no env object is provided", () => {
    const previous = process.env[AFORA_CLI_ENV_VAR];
    deleteTestEnvValue(AFORA_CLI_ENV_VAR);

    try {
      expect(ensureAforaExecMarkerOnProcess()).toBe(process.env);
      expect(process.env[AFORA_CLI_ENV_VAR]).toBe(AFORA_CLI_ENV_VALUE);
    } finally {
      if (previous === undefined) {
        deleteTestEnvValue(AFORA_CLI_ENV_VAR);
      } else {
        setTestEnvValue(AFORA_CLI_ENV_VAR, previous);
      }
    }
  });
});
