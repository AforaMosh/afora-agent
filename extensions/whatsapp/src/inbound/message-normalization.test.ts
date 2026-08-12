// Whatsapp tests cover normalized inbound identity admission boundaries.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setWhatsAppRuntime } from "../runtime.js";
import { createWhatsAppInboundMessageNormalizer } from "./message-normalization.js";

vi.mock("openclaw/plugin-sdk/channel-pairing", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-pairing")>(
    "openclaw/plugin-sdk/channel-pairing",
  );
  return {
    ...actual,
    readChannelAllowFromStore: vi.fn(async () => []),
  };
});

type Entry = { key: string; value: unknown; createdAt: number };
const stores = new Map<string, Map<string, Entry>>();

function openKeyedStore(options: { namespace: string }) {
  let store = stores.get(options.namespace);
  if (!store) {
    store = new Map();
    stores.set(options.namespace, store);
  }
  return {
    registerIfAbsent: async (key: string, value: unknown) => {
      if (store.has(key)) {
        return false;
      }
      store.set(key, { key, value, createdAt: Date.now() });
      return true;
    },
    lookup: async (key: string) => store.get(key)?.value,
    entries: async () => [...store.values()],
    delete: async (key: string) => store.delete(key),
  };
}

describe("inbound message normalization", () => {
  beforeEach(() => {
    stores.clear();
    setWhatsAppRuntime({ state: { openKeyedStore } } as never);
  });

  it("does not persist an unseen direct LID when access control rejects it", async () => {
    const normalize = createWhatsAppInboundMessageNormalizer({
      cfg: { channels: { whatsapp: { dmPolicy: "disabled" } } } as never,
      accountId: "default",
      verbose: false,
      socketSession: {
        connectedAtMs: Date.now(),
        self: { e164: "+15550009999" },
        resolveInboundJidMapping: vi.fn(async () => ({ kind: "no-match", evidence: [] })),
        resolveInboundJid: vi.fn(async () => null),
        sendTrackedMessage: vi.fn(),
      } as never,
      groupMetadata: { get: vi.fn() } as never,
      parseTimestampSeconds: () => undefined,
      logVerbose: vi.fn(),
    }).normalize;

    await expect(
      normalize({
        key: { id: "rejected-lid", remoteJid: "999@lid", fromMe: false },
        message: { conversation: "hello" },
        pushName: "Rejected sender",
      }),
    ).resolves.toBeNull();
    expect([...stores.values()].flatMap((store) => [...store.values()])).toHaveLength(0);
  });
});
