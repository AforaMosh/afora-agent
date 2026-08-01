/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import "./app-host.ts";

type LoginGatewayDraft = {
  loginGatewayUrl: string;
  loginToken: string;
  loginPassword: string;
  updateLoginGatewayUrl: (value: string) => void;
};

describe("OpenClaw app Gateway scope", () => {
  it("clears a password when the login draft changes credential scope", () => {
    const app = document.createElement("openclaw-app") as unknown as LoginGatewayDraft;
    app.loginGatewayUrl = "wss://multi.test?tenant=a";
    app.loginToken = "shared-token";
    app.loginPassword = "tenant-a-password";

    app.updateLoginGatewayUrl("wss://multi.test?tenant=b");

    expect(app.loginToken).toBe("shared-token");
    expect(app.loginPassword).toBe("");
  });
});
