import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOpenAIChatGptSubscriptionAuth } from "./realtime-quicksilver-session.js";
import { openAIQuicksilverAuthHeaders } from "./realtime-quicksilver-wire.js";

const { resolveProviderOAuthAccessMock } = vi.hoisted(() => ({
  resolveProviderOAuthAccessMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveProviderOAuthAccess: resolveProviderOAuthAccessMock,
}));

function createJwt(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = { "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

afterEach(() => {
  resolveProviderOAuthAccessMock.mockReset();
});

describe("GPT-Live OAuth auth resolution", () => {
  it("prefers the persisted account id over JWT metadata", async () => {
    const accessToken = createJwt("account-from-jwt");
    resolveProviderOAuthAccessMock.mockResolvedValue({
      accessToken,
      accountId: "account-from-profile",
    });

    await expect(resolveOpenAIChatGptSubscriptionAuth({})).resolves.toEqual({
      type: "oauth",
      token: accessToken,
      accountId: "account-from-profile",
    });
  });

  it("derives the account id from the JWT for provider headers", async () => {
    const accessToken = createJwt("account-from-jwt");
    resolveProviderOAuthAccessMock.mockResolvedValue({ accessToken });

    const auth = await resolveOpenAIChatGptSubscriptionAuth({});
    expect(auth).toEqual({
      type: "oauth",
      token: accessToken,
      accountId: "account-from-jwt",
    });
    if (!auth) {
      throw new Error("Expected ChatGPT OAuth auth");
    }
    expect(
      openAIQuicksilverAuthHeaders(auth, {
        sessionId: "session-1",
        threadId: "thread-1",
        realtimeSessionId: "realtime-1",
      }),
    ).toMatchObject({
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-ID": "account-from-jwt",
    });
  });

  it("rejects a malformed OAuth token without a persisted account id", async () => {
    resolveProviderOAuthAccessMock.mockResolvedValue({
      accessToken: "not-a-jwt-token",
    });

    await expect(resolveOpenAIChatGptSubscriptionAuth({})).rejects.toThrow(
      "The selected ChatGPT OAuth profile is missing its account id",
    );
  });
});
