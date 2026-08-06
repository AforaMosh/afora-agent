import { describe, expect, it } from "vitest";
import {
  normalizeCodexMcpToolApprovalMode,
  normalizeMcpToolApprovalAnnotations,
  requiresCodexMcpToolApproval,
  resolveEffectiveCodexMcpToolApprovalMode,
} from "./mcp-codex-tool-approval.js";

describe("Codex MCP tool approval contract", () => {
  it.each([
    ["approve", {}, false],
    ["prompt", { readOnlyHint: true }, true],
    ["writes", {}, true],
    ["writes", { readOnlyHint: false }, true],
    ["writes", { readOnlyHint: true }, false],
    ["writes", { readOnlyHint: true, destructiveHint: true }, false],
    ["auto", {}, true],
    ["auto", { readOnlyHint: true }, false],
    ["auto", { readOnlyHint: true, destructiveHint: true }, true],
    ["auto", { destructiveHint: false, openWorldHint: false }, false],
    ["auto", { destructiveHint: false, openWorldHint: true }, true],
    ["auto", { idempotentHint: true }, true],
  ] as const)("applies %s to %j", (mode, annotations, expected) => {
    expect(requiresCodexMcpToolApproval({ mode, annotations })).toBe(expected);
  });

  it("normalizes only host-trusted boolean annotations", () => {
    expect(
      normalizeMcpToolApprovalAnnotations({
        readOnlyHint: true,
        destructiveHint: "false",
        idempotentHint: false,
        openWorldHint: null,
        secret: "do-not-copy",
      }),
    ).toEqual({ readOnlyHint: true, idempotentHint: false });
  });

  it("uses auto for omission and preserves the shipped loopback exception", () => {
    expect(resolveEffectiveCodexMcpToolApprovalMode("remote", {})).toBe("auto");
    expect(
      resolveEffectiveCodexMcpToolApprovalMode("openclaw", {
        url: "http://127.0.0.1:1234/mcp",
      }),
    ).toBe("approve");
  });

  it("keeps the accepted mode set aligned with Codex 0.146.1", () => {
    expect(["auto", "prompt", "writes", "approve"].map(normalizeCodexMcpToolApprovalMode)).toEqual([
      "auto",
      "prompt",
      "writes",
      "approve",
    ]);
  });
});
