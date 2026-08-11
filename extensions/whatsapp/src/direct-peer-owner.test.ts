// Whatsapp tests cover durable direct-peer compatibility ownership.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setWhatsAppRuntime } from "./runtime.js";

const pairingState = vi.hoisted(() => ({
  entries: [] as string[],
  error: undefined as Error | undefined,
}));

vi.mock("openclaw/plugin-sdk/channel-pairing", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-pairing")>(
    "openclaw/plugin-sdk/channel-pairing",
  );
  return {
    ...actual,
    readChannelAllowFromStore: vi.fn(async () => {
      if (pairingState.error) {
        throw pairingState.error;
      }
      return pairingState.entries;
    }),
  };
});

import { clearWhatsAppDirectPeerOwners, resolveWhatsAppDirectPeer } from "./direct-peer-owner.js";

type Entry = { key: string; value: unknown; createdAt: number };
const state = {
  stores: new Map<string, Map<string, Entry>>(),
  registerError: undefined as Error | undefined,
  lookupError: undefined as Error | undefined,
};

function openKeyedStore(options: { namespace: string }) {
  let store = state.stores.get(options.namespace);
  if (!store) {
    store = new Map();
    state.stores.set(options.namespace, store);
  }
  return {
    registerIfAbsent: async (key: string, value: unknown) => {
      if (state.registerError) {
        throw state.registerError;
      }
      if (store.has(key)) {
        return false;
      }
      store.set(key, { key, value, createdAt: Date.now() });
      return true;
    },
    lookup: async (key: string) => {
      if (state.lookupError) {
        throw state.lookupError;
      }
      return store.get(key)?.value;
    },
    entries: async () => [...store.values()],
    delete: async (key: string) => store.delete(key),
  };
}

const noMatch = { kind: "no-match", evidence: [] } as const;
const mapped = {
  kind: "mapped",
  e164: "+15550001111",
  evidence: [{ source: "baileys", outcome: "mapped" }],
} as const;

describe("direct-peer owner", () => {
  beforeEach(() => {
    state.stores.clear();
    state.registerError = undefined;
    state.lookupError = undefined;
    pairingState.entries = [];
    pairingState.error = undefined;
    setWhatsAppRuntime({ state: { openKeyedStore } } as never);
  });

  it("keeps mapped-first peers owned by their E164 identity", async () => {
    await expect(
      resolveWhatsAppDirectPeer({ accountId: "default", jid: "999@lid", mapping: mapped }),
    ).resolves.toMatchObject({ kind: "resolved", peerId: "+15550001111", e164: "+15550001111" });
    expect(
      Array.from(state.stores.values()).flatMap((store) => Array.from(store.values())),
    ).toHaveLength(0);
  });

  it("persists an opaque-first LID owner across later mapping and runtime reuse", async () => {
    await expect(
      resolveWhatsAppDirectPeer({ accountId: "default", jid: "999@lid", mapping: noMatch }),
    ).resolves.toMatchObject({ kind: "resolved", peerId: "999@lid", e164: null });

    setWhatsAppRuntime({ state: { openKeyedStore } } as never);
    await expect(
      resolveWhatsAppDirectPeer({ accountId: "default", jid: "999@lid", mapping: mapped }),
    ).resolves.toMatchObject({ kind: "resolved", peerId: "999@lid", e164: "+15550001111" });
  });

  it("lets exact LID pairing establish durable ownership that survives revocation", async () => {
    pairingState.entries = ["999@lid"];
    await expect(
      resolveWhatsAppDirectPeer({ accountId: "default", jid: "999@lid", mapping: mapped }),
    ).resolves.toMatchObject({ kind: "resolved", peerId: "999@lid" });

    pairingState.entries = [];
    await expect(
      resolveWhatsAppDirectPeer({ accountId: "default", jid: "999@lid", mapping: mapped }),
    ).resolves.toMatchObject({ kind: "resolved", peerId: "999@lid" });

    pairingState.error = new Error("revoked pairing store unavailable");
    await expect(
      resolveWhatsAppDirectPeer({ accountId: "default", jid: "999@lid", mapping: mapped }),
    ).resolves.toMatchObject({ kind: "resolved", peerId: "999@lid" });
  });

  it("turns mapping failures into retryable owner errors without state writes", async () => {
    const result = await resolveWhatsAppDirectPeer({
      accountId: "default",
      jid: "999@lid",
      mapping: {
        kind: "error",
        reason: "mapping-conflict",
        distinctValueCount: 2,
        evidence: [
          { source: "auth", outcome: "mapped" },
          { source: "baileys", outcome: "mapped" },
        ],
      },
    });
    expect(result).toMatchObject({ kind: "error", error: { code: "mapping-error" } });
    expect(result.kind === "error" ? result.error.message : "").toBe(
      "WhatsApp LID mapping conflict across auth, baileys (2 distinct values); reconcile mapping sources and retry.",
    );
    expect(result.kind === "error" ? result.error.message : "").not.toContain("+1555");
    expect(
      Array.from(state.stores.values()).flatMap((store) => Array.from(store.values())),
    ).toHaveLength(0);
  });

  it.each(["lookup", "register", "pairing"] as const)(
    "fails closed when %s owner state is unavailable",
    async (failure) => {
      if (failure === "lookup") {
        state.lookupError = new Error("lookup failed");
      } else if (failure === "register") {
        state.registerError = new Error("capacity reached");
      } else {
        pairingState.error = new Error("pairing store failed");
      }
      await expect(
        resolveWhatsAppDirectPeer({ accountId: "default", jid: "999@lid", mapping: noMatch }),
      ).resolves.toMatchObject({ kind: "error", error: { code: "owner-state-error" } });
    },
  );

  it("clears only the removed account's owner records", async () => {
    await resolveWhatsAppDirectPeer({ accountId: "first", jid: "111@lid", mapping: noMatch });
    await resolveWhatsAppDirectPeer({ accountId: "second", jid: "222@lid", mapping: noMatch });

    await clearWhatsAppDirectPeerOwners("first");

    await expect(
      resolveWhatsAppDirectPeer({ accountId: "second", jid: "222@lid", mapping: mapped }),
    ).resolves.toMatchObject({ kind: "resolved", peerId: "222@lid" });
    await expect(
      resolveWhatsAppDirectPeer({ accountId: "first", jid: "111@lid", mapping: mapped }),
    ).resolves.toMatchObject({ kind: "resolved", peerId: "+15550001111" });
  });
});
