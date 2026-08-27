import { describe, expect, it } from "vitest";
import {
  buildCliBackendToolAvailability,
  resolveCliRuntimeToolsAllow,
  stripAforaMcpToolPrefix,
} from "./tool-policy.js";

describe("buildCliBackendToolAvailability", () => {
  it("keeps canonical names and projects the shipped beta MCP transport names", () => {
    expect(
      buildCliBackendToolAvailability({ native: ["Read"], afora: ["message", "write"] }),
    ).toEqual({
      native: ["Read"],
      afora: ["message", "write"],
      mcp: ["mcp__afora__message", "mcp__afora__write"],
    });
  });
});

describe("stripAforaMcpToolPrefix", () => {
  it("strips only the loopback transport prefix", () => {
    expect(stripAforaMcpToolPrefix("mcp__afora__memory_search")).toBe("memory_search");
    expect(stripAforaMcpToolPrefix("memory_search")).toBe("memory_search");
    expect(stripAforaMcpToolPrefix("mcp__other__tool")).toBe("mcp__other__tool");
  });
});

describe("resolveCliRuntimeToolsAllow", () => {
  it("keeps every concrete restriction, including server-managed defaults", () => {
    expect(resolveCliRuntimeToolsAllow(undefined)).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow(["memory_search"], true)).toEqual(["memory_search"]);
    expect(resolveCliRuntimeToolsAllow(["*"])).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow(["memory_search"])).toEqual(["memory_search"]);
  });
});
