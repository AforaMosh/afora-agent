import { beforeEach, describe, expect, it, vi } from "vitest";

const oauthRuntimeMocks = vi.hoisted(() => ({
  loginXaiDeviceCode: vi.fn(),
}));

vi.mock("./xai-oauth.js", () => oauthRuntimeMocks);

beforeEach(() => {
  vi.resetModules();
  oauthRuntimeMocks.loginXaiDeviceCode.mockReset();
  oauthRuntimeMocks.loginXaiDeviceCode.mockResolvedValue({ profiles: [] });
});

describe("xAI OAuth lazy entry", () => {
  it("loads OAuth runtime only when an auth operation runs", async () => {
    const entry = await import("./xai-oauth-entry.js");
    const method = entry.createXaiOAuthAuthMethod();

    expect(oauthRuntimeMocks.loginXaiDeviceCode).not.toHaveBeenCalled();

    await method.run({} as never);
    expect(oauthRuntimeMocks.loginXaiDeviceCode).toHaveBeenCalledOnce();
  });
});
