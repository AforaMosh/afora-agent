import { describe, expect, it, vi } from "vitest";

vi.mock("../auth-profiles/constants.js", async () => {
  const actual = await vi.importActual<typeof import("../auth-profiles/constants.js")>(
    "../auth-profiles/constants.js",
  );
  return { ...actual, OAUTH_REFRESH_CALL_TIMEOUT_MS: 10 };
});

import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import { AuthStorage } from "./auth-storage.js";

function registerRaceProvider(
  storage: AuthStorage,
  refreshToken: (credentials: {
    access: string;
    refresh: string;
    expires: number;
  }) => Promise<{ access: string; refresh: string; expires: number }>,
) {
  getAuthStorageOAuthProviderRegistry(storage).register({
    id: "test-oauth",
    name: "Test OAuth",
    async login() {
      throw new Error("not used");
    },
    refreshToken,
    getApiKey(credentials) {
      return credentials.access;
    },
  });
}

describe("AuthStorage OAuth refresh ownership", () => {
  it("bounds callers while retaining late success and queue ownership", async () => {
    const storage = AuthStorage.inMemory({
      "test-oauth": {
        type: "oauth",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: 1,
      },
    });
    const stalled = Promise.withResolvers<{
      access: string;
      refresh: string;
      expires: number;
    }>();
    const refreshToken = vi.fn(async () => await stalled.promise);
    registerRaceProvider(storage, refreshToken);

    await expect(storage.getApiKey("test-oauth")).resolves.toBeUndefined();
    expect(storage.drainErrors()[0]?.message).toContain("exceeded caller deadline");
    const second = storage.getApiKey("test-oauth");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(refreshToken).toHaveBeenCalledOnce();

    stalled.resolve({
      access: "late-access",
      refresh: "late-refresh",
      expires: Date.now() + 10 * 60_000,
    });
    await expect(second).resolves.toBe("late-access");
    expect(storage.get("test-oauth")).toMatchObject({
      access: "late-access",
      refresh: "late-refresh",
    });
    expect(refreshToken).toHaveBeenCalledOnce();
  });
});

describe("AuthStorage OAuth refresh conflicts", () => {
  it("rejects an expired rotated credential without persisting it", async () => {
    const original = {
      type: "oauth" as const,
      access: "expired-access",
      refresh: "expired-refresh",
      expires: 1,
    };
    const storage = AuthStorage.inMemory({ "test-oauth": original });
    registerRaceProvider(storage, async () => ({
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: Date.now(),
    }));

    await expect(storage.getApiKey("test-oauth")).resolves.toBeUndefined();
    expect(storage.get("test-oauth")).toEqual(original);
    expect(JSON.stringify(storage.getAll())).not.toContain("rotated-access");
    expect(JSON.stringify(storage.getAll())).not.toContain("rotated-refresh");
    expect(storage.drainErrors().map((error) => error.message)).toEqual([
      "OAuth provider returned an expired credential",
    ]);
  });

  it("persists a same-identity rotation and preserves attempted metadata", async () => {
    const storage = AuthStorage.inMemory({
      "test-oauth": {
        type: "oauth",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: 1,
        accountId: "account-1",
      },
    });
    registerRaceProvider(storage, async () => {
      storage.set("test-oauth", {
        type: "oauth",
        access: "racing-access",
        refresh: "racing-refresh",
        expires: Date.now() + 30_000,
        accountId: "account-1",
      });
      return {
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 10 * 60_000,
      };
    });

    await expect(storage.getApiKey("test-oauth")).resolves.toBe("rotated-access");
    expect(storage.get("test-oauth")).toMatchObject({
      provider: "test-oauth",
      access: "rotated-access",
      refresh: "rotated-refresh",
      accountId: "account-1",
    });
  });

  it("adopts a usable different identity without overwriting it", async () => {
    const storage = AuthStorage.inMemory({
      "test-oauth": {
        type: "oauth",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: 1,
        accountId: "account-1",
      },
    });
    registerRaceProvider(storage, async () => {
      storage.set("test-oauth", {
        type: "oauth",
        access: "relogged-access",
        refresh: "relogged-refresh",
        expires: Date.now() + 10 * 60_000,
        accountId: "account-2",
      });
      return {
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 10 * 60_000,
      };
    });

    await expect(storage.getApiKey("test-oauth")).resolves.toBe("relogged-access");
    expect(storage.get("test-oauth")).toMatchObject({
      access: "relogged-access",
      refresh: "relogged-refresh",
      accountId: "account-2",
    });
  });

  it.each([
    {
      name: "removed authority",
      mutate: (storage: AuthStorage) => {
        storage.logout("test-oauth");
      },
      expected: undefined,
    },
    {
      name: "non-OAuth authority",
      mutate: (storage: AuthStorage) => {
        storage.set("test-oauth", { type: "api_key", key: "replacement-key" });
      },
      expected: { type: "api_key", key: "replacement-key" },
    },
    {
      name: "expired different identity",
      mutate: (storage: AuthStorage) => {
        storage.set("test-oauth", {
          type: "oauth",
          access: "other-expired-access",
          refresh: "other-expired-refresh",
          expires: 1,
          accountId: "account-2",
        });
      },
      expected: { type: "oauth", access: "other-expired-access", accountId: "account-2" },
    },
  ])("does not resurrect refreshed credentials over $name", async ({ mutate, expected }) => {
    const storage = AuthStorage.inMemory({
      "test-oauth": {
        type: "oauth",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: 1,
        accountId: "account-1",
      },
    });
    registerRaceProvider(storage, async () => {
      mutate(storage);
      return {
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 10 * 60_000,
      };
    });

    await expect(storage.getApiKey("test-oauth")).resolves.toBeUndefined();
    if (expected) {
      expect(storage.get("test-oauth")).toEqual(expect.objectContaining(expected));
    } else {
      expect(storage.get("test-oauth")).toBeUndefined();
    }
  });
});
