// Tests gateway process argv parsing for diagnostics.
import { describe, expect, it } from "vitest";
import {
  isGatewayArgv,
  isAforaArgv,
  isAforaCommandArgv,
  parseProcCmdline,
} from "./gateway-process-argv.js";

describe("parseProcCmdline", () => {
  it("splits null-delimited argv and trims empty entries", () => {
    expect(parseProcCmdline(" node \0 gateway \0\0 --port \0 18789 \0")).toEqual([
      "node",
      "gateway",
      "--port",
      "18789",
    ]);
  });

  it("keeps non-delimited single arguments and drops whitespace-only entries", () => {
    expect(parseProcCmdline(" gateway ")).toEqual(["gateway"]);
    expect(parseProcCmdline(" \0\t\0 ")).toStrictEqual([]);
  });
});

describe("isGatewayArgv", () => {
  it("requires a gateway token", () => {
    expect(isGatewayArgv(["node", "dist/index.js", "--port", "18789"])).toBe(false);
  });

  it("matches known entrypoints across slash and case variants", () => {
    expect(isGatewayArgv(["NODE", "C:\\Afora\\DIST\\ENTRY.JS", "gateway"])).toBe(true);
    expect(isGatewayArgv(["bun", "/srv/afora/scripts/run-node.mjs", "gateway"])).toBe(true);
    expect(isGatewayArgv(["node", "/srv/afora/afora.mjs", "gateway"])).toBe(true);
    expect(isGatewayArgv(["tsx", "/srv/afora/src/entry.ts", "gateway"])).toBe(true);
    expect(isGatewayArgv(["tsx", "/srv/afora/src/index.ts", "gateway"])).toBe(true);
  });

  it("matches the afora executable but gates the gateway binary behind the opt-in flag", () => {
    expect(isGatewayArgv(["C:\\bin\\afora.cmd", "gateway"])).toBe(true);
    expect(isGatewayArgv(["/usr/local/bin/afora-gateway", "gateway"])).toBe(false);
    expect(isGatewayArgv(["afora-gateway"])).toBe(false);
    expect(
      isGatewayArgv(["/usr/local/bin/afora-gateway", "gateway"], {
        allowGatewayBinary: true,
      }),
    ).toBe(true);
    expect(
      isGatewayArgv(["C:\\bin\\afora-gateway.EXE", "gateway"], {
        allowGatewayBinary: true,
      }),
    ).toBe(true);
    expect(isGatewayArgv(["afora-gateway"], { allowGatewayBinary: true })).toBe(true);
  });

  it("rejects unknown gateway argv even when the token is present", () => {
    expect(isGatewayArgv(["node", "/srv/afora/custom.js", "gateway"])).toBe(false);
    expect(isGatewayArgv(["python", "gateway", "script.py"])).toBe(false);
  });
});

describe("isAforaCommandArgv", () => {
  it("matches doctor across source, built, and installed entrypoints", () => {
    expect(isAforaCommandArgv(["node", "/srv/afora/afora.mjs", "doctor"], "doctor")).toBe(true);
    expect(isAforaCommandArgv(["NODE", "C:\\Afora\\DIST\\ENTRY.JS", "DOCTOR"], "doctor")).toBe(
      true,
    );
    expect(isAforaCommandArgv(["C:\\bin\\afora.cmd", "doctor", "--fix"], "doctor")).toBe(true);
  });

  it("rejects other Afora commands and unrelated doctor processes", () => {
    expect(isAforaCommandArgv(["afora", "gateway"], "doctor")).toBe(false);
    expect(isAforaCommandArgv(["python", "doctor", "worker.py"], "doctor")).toBe(false);
  });
});

describe("isAforaArgv", () => {
  it.each([
    ["agent exec", ["afora", "agent", "exec", "task"]],
    ["local TUI", ["node", "/srv/afora/afora.mjs", "tui", "--local"]],
    ["models probe", ["afora", "models", "status", "--probe"]],
    ["bare local TUI", ["afora"]],
  ])("recognizes the %s embedded owner", (_label, argv) => {
    expect(isAforaArgv(argv)).toBe(true);
  });

  it("rejects an unrelated process", () => {
    expect(isAforaArgv(["python", "worker.py"])).toBe(false);
  });
});
