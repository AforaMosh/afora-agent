// Systemd unit tests cover generated systemd unit files.
import { describe, expect, it } from "vitest";
import {
  buildSystemdUnit,
  parseSystemdEnvAssignments,
  parseSystemdExecStart,
  renderSystemdEnvAssignment,
} from "./systemd-unit.js";

// Values that need quoting, including the backslash and quote shapes the
// renderer has to escape for the module's own parsers to read them back.
const ROUND_TRIP_VALUES = [
  "plain",
  "with space",
  'he said "hi"',
  "back\\slash",
  "C:\\\\srv\\\\bin",
  'mix \\ and " here',
  "trailing\\",
];

describe("systemd unit value round-trips", () => {
  it.each(ROUND_TRIP_VALUES)("round-trips %p through Environment=", (value) => {
    const rendered = renderSystemdEnvAssignment("AFORA_TOKEN", value);
    expect(parseSystemdEnvAssignments(rendered)).toEqual([{ key: "AFORA_TOKEN", value }]);
  });

  it.each(ROUND_TRIP_VALUES)("round-trips %p through ExecStart=", (value) => {
    const unit = buildSystemdUnit({
      description: "Afora Gateway",
      programArguments: ["/usr/bin/afora", "gateway", value],
      environment: {},
    });
    const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
    expect(parseSystemdExecStart(execStart?.slice("ExecStart=".length) ?? "")).toEqual([
      "/usr/bin/afora",
      "gateway",
      value,
    ]);
  });
});

describe("buildSystemdUnit", () => {
  it("quotes arguments with whitespace", () => {
    const unit = buildSystemdUnit({
      description: "Afora Gateway",
      programArguments: ["/usr/bin/afora", "gateway", "--name", "My Bot"],
      environment: {},
    });
    const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
    expect(execStart).toBe('ExecStart=/usr/bin/afora gateway --name "My Bot"');
  });

  it("renders control-group kill mode for child-process cleanup", () => {
    const unit = buildSystemdUnit({
      description: "Afora Gateway",
      programArguments: ["/usr/bin/afora", "gateway", "run"],
      environment: {},
    });
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("TimeoutStopSec=30");
    expect(unit).toContain("TimeoutStartSec=30");
    expect(unit).toContain("SuccessExitStatus=0 143");
    expect(unit).toContain("OOMPolicy=continue");
    expect(unit).toContain("StartLimitBurst=5");
    expect(unit).toContain("StartLimitIntervalSec=60");
    expect(unit).toContain("RestartPreventExitStatus=78");
  });

  it("rejects environment values with line breaks", () => {
    expect(() =>
      buildSystemdUnit({
        description: "Afora Gateway",
        programArguments: ["/usr/bin/afora", "gateway", "start"],
        environment: {
          INJECT: "ok\nExecStartPre=/bin/touch /tmp/oc15789_rce",
        },
      }),
    ).toThrow(/CR or LF/);
  });

  it("renders EnvironmentFile entries before inline Environment values", () => {
    const unit = buildSystemdUnit({
      description: "Afora Gateway",
      programArguments: ["/usr/bin/afora", "gateway", "run"],
      environmentFiles: ["/home/test/.afora/.env"],
      environment: {
        AFORA_GATEWAY_PORT: "18789",
      },
    });
    expect(unit).toContain("EnvironmentFile=-/home/test/.afora/.env");
    expect(unit).toContain("Environment=AFORA_GATEWAY_PORT=18789");
    expect(unit.indexOf("EnvironmentFile=-/home/test/.afora/.env")).toBeLessThan(
      unit.indexOf("Environment=AFORA_GATEWAY_PORT=18789"),
    );
  });
});
