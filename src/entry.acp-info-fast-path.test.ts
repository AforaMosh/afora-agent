import { describe, expect, it, vi } from "vitest";
import { ACP_RUNTIME_INFO } from "./acp/runtime-info.js";
import { tryHandleAcpInfoFastPath } from "./entry.acp-info-fast-path.js";

describe("ACP info fast path", () => {
  it("prints the embedded stdio contract and exits", () => {
    const output = vi.fn();
    const exit = vi.fn();

    expect(tryHandleAcpInfoFastPath(["node", "openclaw", "acp", "info"], { output, exit })).toBe(
      true,
    );
    expect(output).toHaveBeenCalledWith(JSON.stringify(ACP_RUNTIME_INFO));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it.each([
    ["node", "openclaw", "acp"],
    ["node", "openclaw", "acp", "info", "--help"],
    ["node", "openclaw", "acp", "client"],
    ["node", "openclaw", "--container", "demo", "acp", "info"],
  ])("leaves non-exact invocations to the normal CLI", (...argv) => {
    expect(tryHandleAcpInfoFastPath(argv)).toBe(false);
  });
});
