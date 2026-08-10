import { afterEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { getRuntimeAuthProfileStoreCredentialMutationToken } from "./runtime-snapshots.js";
import type { AuthProfileStore } from "./types.js";

type ResolveProviderOAuthCredentialWithPlugin =
  typeof import("../../plugins/provider-runtime.runtime.js").resolveProviderOAuthCredentialWithPlugin;

const { resolveProviderOAuthCredentialWithPluginMock } = vi.hoisted(() => ({
  resolveProviderOAuthCredentialWithPluginMock: vi.fn<ResolveProviderOAuthCredentialWithPlugin>(),
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  resolveProviderRuntimePluginHandle: async (params: object) => ({ ...params, plugin: {} }),
  resolveProviderOAuthCredentialWithPlugin: resolveProviderOAuthCredentialWithPluginMock,
}));

describe("OAuth access-token projection", () => {
  afterEach(() => {
    resolveProviderOAuthCredentialWithPluginMock.mockReset();
  });

  it("resolves a usable credential without loading provider formatting", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 10 * 60_000,
        },
      },
    };
    const { resolveOAuthCredentialForProfile } = await import("./oauth.js");

    await expect(
      resolveOAuthCredentialForProfile({
        cfg: {},
        store,
        profileId: "openai:default",
      }),
    ).resolves.toEqual(store.profiles["openai:default"]);
    expect(resolveProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
  });

  it("persists a refreshed expired credential and advances its runtime revision", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-oauth-access-refresh-",
        agentEnv: "main",
      },
      async (state) => {
        const profileId = "openai:default";
        const storedCredential = {
          type: "oauth" as const,
          provider: "openai",
          access: "expired-access",
          refresh: "fake-refresh",
          expires: Date.now() - 60_000,
        };
        const refreshedCredential = {
          ...storedCredential,
          access: "refreshed-access",
          refresh: "refreshed-fake-refresh",
          expires: Date.now() + 60 * 60_000,
        };
        const store: AuthProfileStore = {
          version: 1,
          profiles: { [profileId]: storedCredential },
        };
        await state.writeAuthProfiles(store);
        const initialRevision = getRuntimeAuthProfileStoreCredentialMutationToken(
          state.agentDir(),
          profileId,
        ).revision;
        resolveProviderOAuthCredentialWithPluginMock.mockResolvedValue({
          status: "available",
          credential: refreshedCredential,
          apiKey: refreshedCredential.access,
        });
        const { resolveOAuthCredentialForProfile } = await import("./oauth.js");

        await expect(
          resolveOAuthCredentialForProfile({
            cfg: {},
            store,
            profileId,
            agentDir: state.agentDir(),
          }),
        ).resolves.toEqual(refreshedCredential);
        expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles[profileId]).toEqual(
          refreshedCredential,
        );
        expect(
          getRuntimeAuthProfileStoreCredentialMutationToken(state.agentDir(), profileId).revision,
        ).toBeGreaterThan(initialRevision);
      },
    );
  });

  it("preserves OAuth SecretRef policy validation", async () => {
    const profileId = "openai:secret-ref";
    const store = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "openai",
          access: { source: "env", provider: "default", id: "OPENAI_ACCESS_TOKEN" },
          refresh: "oauth-refresh",
          expires: Date.now() + 10 * 60_000,
        },
      },
    } as unknown as AuthProfileStore;
    const { resolveOAuthCredentialForProfile } = await import("./oauth.js");

    await expect(
      resolveOAuthCredentialForProfile({
        cfg: {},
        store,
        profileId,
      }),
    ).rejects.toThrow(/OAuth \+ SecretRef is not supported/);
  });
});
