// Covers supervisor marker files used to identify managed Afora processes.
import { describe, expect, it } from "vitest";
import {
  detectGatewayRespawnSupervisor,
  detectRespawnSupervisor,
  SUPERVISOR_HINT_ENV_VARS,
} from "./supervisor-markers.js";

describe("SUPERVISOR_HINT_ENV_VARS", () => {
  it("includes the cross-platform supervisor hint env vars", () => {
    const envVars = new Set(SUPERVISOR_HINT_ENV_VARS);
    expect(envVars.has("AFORA_SUPERVISOR_MODE")).toBe(true);
    expect(envVars.has("LAUNCH_JOB_LABEL")).toBe(true);
    expect(envVars.has("INVOCATION_ID")).toBe(true);
    expect(envVars.has("AFORA_WINDOWS_TASK_NAME")).toBe(true);
    expect(envVars.has("AFORA_SERVICE_MARKER")).toBe(true);
    expect(envVars.has("AFORA_SERVICE_KIND")).toBe(true);
  });
});

describe("detectRespawnSupervisor", () => {
  it("detects launchd from Afora's explicit marker or current gateway launchd job", () => {
    expect(
      detectRespawnSupervisor({ AFORA_LAUNCHD_LABEL: " ai.afora.gateway " }, "darwin"),
    ).toBe("launchd");
    expect(detectRespawnSupervisor({ AFORA_LAUNCHD_LABEL: "   " }, "darwin")).toBeNull();
    expect(detectRespawnSupervisor({ LAUNCH_JOB_LABEL: "ai.afora.gateway" }, "darwin")).toBe(
      "launchd",
    );
    expect(
      detectRespawnSupervisor(
        { LAUNCH_JOB_NAME: "ai.afora.work", AFORA_PROFILE: "work" },
        "darwin",
      ),
    ).toBe("launchd");
    expect(detectRespawnSupervisor({ LAUNCH_JOB_LABEL: "ai.afora.mac" }, "darwin")).toBeNull();
    expect(detectRespawnSupervisor({ XPC_SERVICE_NAME: "ai.afora.mac" }, "darwin")).toBeNull();
    expect(
      detectRespawnSupervisor(
        { XPC_SERVICE_NAME: "ai.afora.mac", AFORA_PROFILE: "mac" },
        "darwin",
      ),
    ).toBeNull();
    expect(detectRespawnSupervisor({ XPC_SERVICE_NAME: "ai.afora.gateway" }, "darwin")).toBe(
      "launchd",
    );
  });

  it("detects systemd only from non-blank platform-specific hints", () => {
    expect(detectRespawnSupervisor({ INVOCATION_ID: "abc123" }, "linux")).toBe("systemd");
    expect(detectRespawnSupervisor({ JOURNAL_STREAM: "" }, "linux")).toBeNull();
  });

  it("detects Linux Afora gateway service markers only for opt-in callers", () => {
    const gatewayServiceEnv = {
      AFORA_SERVICE_MARKER: " afora ",
      AFORA_SERVICE_KIND: " gateway ",
    };
    expect(detectRespawnSupervisor(gatewayServiceEnv, "linux")).toBeNull();
    expect(
      detectRespawnSupervisor(gatewayServiceEnv, "linux", {
        includeLinuxAforaGatewayServiceMarker: true,
      }),
    ).toBe("systemd");
    expect(
      detectRespawnSupervisor(
        {
          AFORA_SERVICE_MARKER: "afora",
          AFORA_SERVICE_KIND: "worker",
        },
        "linux",
        { includeLinuxAforaGatewayServiceMarker: true },
      ),
    ).toBeNull();
    expect(
      detectRespawnSupervisor(
        {
          AFORA_SERVICE_MARKER: "other",
          AFORA_SERVICE_KIND: "gateway",
        },
        "linux",
        { includeLinuxAforaGatewayServiceMarker: true },
      ),
    ).toBeNull();
  });

  it("detects scheduled-task supervision on Windows from either hint family", () => {
    expect(
      detectRespawnSupervisor({ AFORA_WINDOWS_TASK_NAME: "Afora Gateway" }, "win32"),
    ).toBe("schtasks");
    expect(
      detectRespawnSupervisor(
        {
          AFORA_SERVICE_MARKER: "afora",
          AFORA_SERVICE_KIND: "gateway",
        },
        "win32",
      ),
    ).toBe("schtasks");
    expect(
      detectRespawnSupervisor(
        {
          AFORA_SERVICE_MARKER: "afora",
          AFORA_SERVICE_KIND: "worker",
        },
        "win32",
      ),
    ).toBeNull();
  });

  it("ignores service markers on non-Windows platforms and unknown platforms", () => {
    expect(
      detectRespawnSupervisor(
        {
          AFORA_SERVICE_MARKER: "afora",
          AFORA_SERVICE_KIND: "gateway",
        },
        "linux",
      ),
    ).toBeNull();
    expect(
      detectRespawnSupervisor({ LAUNCH_JOB_LABEL: "ai.afora.gateway" }, "freebsd"),
    ).toBeNull();
  });
});

describe("detectGatewayRespawnSupervisor", () => {
  it("keeps external ownership separate from native supervisor detection", () => {
    const env = {
      AFORA_SUPERVISOR_MODE: "external",
      AFORA_LAUNCHD_LABEL: "ai.afora.gateway",
    };

    expect(detectGatewayRespawnSupervisor(env, "darwin")).toBe("external");
    expect(detectRespawnSupervisor(env, "darwin")).toBe("launchd");
  });
});
