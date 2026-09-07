/* @vitest-environment jsdom */
// A browser paired before the rename holds the pre-rename localStorage keys, and nothing in a
// browser plays the part doctor plays on a server: if the console stops reading those keys, the
// tenant is silently unpaired and has to approve the device again. Each case here is the upgrade
// a live tenant performs, so it fails the way that tenant would notice.

import { gatewayCredentialScope } from "@afora/gateway-client/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";

const GATEWAY_URL = "wss://gateway.test/?tenant=1";
const DEVICE_ID = "00";

const CANONICAL_AUTH_KEY_PREFIX = "afora.device.auth.v1:";
const CANONICAL_IDENTITY_KEY = "afora-device-identity-v1";
// afora-compat: the two spellings shipped builds wrote before the rename.
const PRE_RENAME_AUTH_KEY = "openclaw.device.auth.v1";
const PRE_RENAME_IDENTITY_KEY = "openclaw-device-identity-v1";

function canonicalAuthKey(): string {
  return `${CANONICAL_AUTH_KEY_PREFIX}${gatewayCredentialScope(GATEWAY_URL)}`;
}

function preRenameScopedAuthKey(): string {
  return `${PRE_RENAME_AUTH_KEY}:${gatewayCredentialScope(GATEWAY_URL)}`;
}

function deviceAuthStoreJson(deviceId: string, token: string): string {
  return JSON.stringify({
    version: 1,
    deviceId,
    tokens: { operator: { token, role: "operator", scopes: [], updatedAtMs: 1 } },
  });
}

// `loadOrCreateDeviceIdentity` keeps one minted identity per module instance so a storage-blocked
// page stays one device. Reloading the module drops that cache, so a legacy-key miss shows up as a
// newly minted device id rather than being masked by the previous test's mint.
async function loadNodesModule() {
  vi.resetModules();
  return await import("./index.ts");
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  return () => {
    vi.unstubAllGlobals();
  };
});

describe.each([
  { shape: "scoped", key: preRenameScopedAuthKey },
  { shape: "origin-wide", key: () => PRE_RENAME_AUTH_KEY },
])("a device token written before the rename ($shape)", ({ key }) => {
  it("still authorizes, and is claimed onto the canonical key", async () => {
    const { loadDeviceAuthToken } = await loadNodesModule();
    localStorage.setItem(key(), deviceAuthStoreJson(DEVICE_ID, "paired-token"));

    const entry = loadDeviceAuthToken({
      deviceId: DEVICE_ID,
      gatewayUrl: GATEWAY_URL,
      role: "operator",
    });

    expect(entry?.token).toBe("paired-token");
    expect(JSON.parse(localStorage.getItem(canonicalAuthKey()) ?? "null")).toMatchObject({
      deviceId: DEVICE_ID,
    });
    // Claimed, not merely copied: leaving it behind lets a sibling route claim it a second time.
    expect(localStorage.getItem(key())).toBeNull();
  });
});

describe("device auth key precedence", () => {
  it("prefers the canonical scoped entry and clears every superseded key", async () => {
    const { loadDeviceAuthToken } = await loadNodesModule();
    localStorage.setItem(canonicalAuthKey(), deviceAuthStoreJson(DEVICE_ID, "current-token"));
    localStorage.setItem(preRenameScopedAuthKey(), deviceAuthStoreJson(DEVICE_ID, "stale-scoped"));
    localStorage.setItem(PRE_RENAME_AUTH_KEY, deviceAuthStoreJson(DEVICE_ID, "stale-origin-wide"));

    const entry = loadDeviceAuthToken({
      deviceId: DEVICE_ID,
      gatewayUrl: GATEWAY_URL,
      role: "operator",
    });

    expect(entry?.token).toBe("current-token");
    expect(localStorage.getItem(preRenameScopedAuthKey())).toBeNull();
    expect(localStorage.getItem(PRE_RENAME_AUTH_KEY)).toBeNull();
  });

  it("prefers the pre-rename scoped entry over the origin-wide one", async () => {
    const { loadDeviceAuthToken } = await loadNodesModule();
    localStorage.setItem(preRenameScopedAuthKey(), deviceAuthStoreJson(DEVICE_ID, "this-gateway"));
    localStorage.setItem(PRE_RENAME_AUTH_KEY, deviceAuthStoreJson(DEVICE_ID, "any-gateway"));

    const entry = loadDeviceAuthToken({
      deviceId: DEVICE_ID,
      gatewayUrl: GATEWAY_URL,
      role: "operator",
    });

    expect(entry?.token).toBe("this-gateway");
  });

  it("writes only the canonical key and drops the pre-rename ones", async () => {
    const { storeDeviceAuthToken } = await loadNodesModule();
    localStorage.setItem(PRE_RENAME_AUTH_KEY, deviceAuthStoreJson(DEVICE_ID, "stale-origin-wide"));

    storeDeviceAuthToken({
      deviceId: DEVICE_ID,
      gatewayUrl: GATEWAY_URL,
      role: "operator",
      token: "fresh-token",
    });

    expect(JSON.parse(localStorage.getItem(canonicalAuthKey()) ?? "null")).toMatchObject({
      deviceId: DEVICE_ID,
    });
    expect(localStorage.getItem(PRE_RENAME_AUTH_KEY)).toBeNull();
    expect(localStorage.getItem(preRenameScopedAuthKey())).toBeNull();
  });
});

describe("device identity written before the rename", () => {
  it("is reused rather than replaced, and is migrated forward", async () => {
    // Mint through the production writer so the fixture agrees with the fingerprint by
    // construction; a hand-written key pair would only prove what the fixture asserted.
    const minter = await loadNodesModule();
    const minted = await minter.loadOrCreateDeviceIdentity();
    const identityJson = localStorage.getItem(CANONICAL_IDENTITY_KEY);
    expect(identityJson).not.toBeNull();

    localStorage.clear();
    localStorage.setItem(PRE_RENAME_IDENTITY_KEY, identityJson ?? "");

    const reader = await loadNodesModule();
    const reloaded = await reader.loadOrCreateDeviceIdentity();

    expect(reloaded.deviceId).toBe(minted.deviceId);
    expect(reloaded.publicKey).toBe(minted.publicKey);
    expect(localStorage.getItem(CANONICAL_IDENTITY_KEY)).toBe(identityJson);
    expect(localStorage.getItem(PRE_RENAME_IDENTITY_KEY)).toBeNull();
  });

  it("carries the whole pairing across, not just one half of it", async () => {
    const minter = await loadNodesModule();
    const minted = await minter.loadOrCreateDeviceIdentity();
    const identityJson = localStorage.getItem(CANONICAL_IDENTITY_KEY);

    // Exactly what a browser last used before the rename holds: both keys, previous spelling.
    localStorage.clear();
    localStorage.setItem(PRE_RENAME_IDENTITY_KEY, identityJson ?? "");
    localStorage.setItem(
      preRenameScopedAuthKey(),
      deviceAuthStoreJson(minted.deviceId, "paired-token"),
    );

    const reader = await loadNodesModule();
    const identity = await reader.loadOrCreateDeviceIdentity();
    const entry = reader.loadDeviceAuthToken({
      deviceId: identity.deviceId,
      gatewayUrl: GATEWAY_URL,
      role: "operator",
    });

    // The token is bound to the device id, so losing either key alone still costs the pairing.
    expect(entry?.token).toBe("paired-token");
  });
});
