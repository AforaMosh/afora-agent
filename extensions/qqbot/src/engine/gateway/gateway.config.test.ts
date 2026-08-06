import { describe, expect, it } from "vitest";
import { startGateway, type CoreGatewayContext } from "./gateway.js";

function makeContext(accountId: string): CoreGatewayContext {
  return {
    account: {
      accountId,
      appId: "",
      clientSecret: "",
      markdownSupport: false,
      config: {},
    },
    adapters: {
      commands: {},
      outboundAudio: {},
    },
  } as unknown as CoreGatewayContext;
}

describe("QQBot gateway configuration guidance", () => {
  it("shows default-account recovery paths from the real gateway entry point", async () => {
    await expect(startGateway(makeContext("default"))).rejects.toThrow(
      /channels\.qqbot\.appId.*QQBOT_APP_ID and QQBOT_CLIENT_SECRET/,
    );
  });

  it("shows account-scoped recovery without default-only env vars", async () => {
    let error: unknown;
    try {
      await startGateway(makeContext("operations"));
    } catch (caught) {
      error = caught;
    }

    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("channels.qqbot.accounts.operations.appId");
    expect(message).not.toContain("QQBOT_APP_ID");
    expect(message).not.toContain("QQBOT_CLIENT_SECRET");
  });
});
