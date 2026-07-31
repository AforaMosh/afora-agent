import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("process-local ACP runtime boundary", () => {
  it("does not depend on Gateway runtime or protocol clients", () => {
    for (const file of [
      "approval-host.ts",
      "local-agent.ts",
      "local-session-controller.ts",
      "local-session-runtime.ts",
      "local-turn-runtime.ts",
      "server.ts",
      "session-mapper.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/from\s+["'][^"']*gateway\//);
      expect(source, file).not.toMatch(/gateway-protocol|GatewayClient|callGateway/);
    }
  });
});
