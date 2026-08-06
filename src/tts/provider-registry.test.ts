// TTS provider registry tests cover registration and provider resolution.
import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import {
  createSpeechProviderRegistry,
  normalizeSpeechProviderId,
} from "./provider-registry-core.js";
import { resolveTtsProviderOrder } from "./tts-provider-resolution.js";

function createSpeechProvider(id: string, aliases?: string[]): SpeechProviderPlugin {
  return {
    id,
    label: id,
    ...(aliases ? { aliases } : {}),
    isConfigured: () => true,
    synthesize: async () => ({
      audioBuffer: Buffer.from("audio"),
      outputFormat: "mp3",
      voiceCompatible: false,
      fileExtension: ".mp3",
    }),
  };
}

describe("speech provider registry", () => {
  const getProviderCalls: Array<{ providerId: string; cfg?: OpenClawConfig }> = [];
  const listProvidersCalls: Array<{ cfg?: OpenClawConfig }> = [];
  let providers: SpeechProviderPlugin[] = [];
  let directProvider: SpeechProviderPlugin | undefined;
  let registry: ReturnType<typeof createSpeechProviderRegistry>;

  beforeEach(() => {
    providers = [];
    directProvider = undefined;
    getProviderCalls.length = 0;
    listProvidersCalls.length = 0;
    registry = createSpeechProviderRegistry({
      getProvider: (providerId, cfg) => {
        getProviderCalls.push({ providerId, cfg });
        return directProvider;
      },
      listProviders: (cfg) => {
        listProvidersCalls.push({ cfg });
        return providers;
      },
    });
  });

  it("lists providers from the speech capability runtime", () => {
    const cfg = {} as OpenClawConfig;
    providers = [createSpeechProvider("demo-speech")];

    expect(registry.listSpeechProviders(cfg).map((provider) => provider.id)).toEqual([
      "demo-speech",
    ]);
    expect(listProvidersCalls).toEqual([{ cfg }]);
  });

  it("gets providers by normalized id through the capability runtime", () => {
    const cfg = {} as OpenClawConfig;
    directProvider = createSpeechProvider("microsoft", ["edge"]);

    expect(registry.getSpeechProvider(" MICROSOFT ", cfg)).toBe(directProvider);
    expect(getProviderCalls).toEqual([{ providerId: "microsoft", cfg }]);
  });

  it("canonicalizes aliases from listed providers when direct lookup misses", () => {
    providers = [createSpeechProvider("microsoft", ["edge"])];

    expect(normalizeSpeechProviderId("edge")).toBe("edge");
    expect(registry.canonicalizeSpeechProviderId("edge")).toBe("microsoft");
  });

  it("resolves fallback order and aliases from a supplied provider inventory", () => {
    const inventory = [
      { ...createSpeechProvider("openai", ["oai"]), autoSelectOrder: 5 },
      { ...createSpeechProvider("google"), autoSelectOrder: 1 },
      { ...createSpeechProvider("elevenlabs"), autoSelectOrder: 3 },
    ];

    expect(
      resolveTtsProviderOrder(
        " OAI " as Parameters<typeof resolveTtsProviderOrder>[0],
        undefined,
        inventory,
      ),
    ).toEqual(["openai", "google", "elevenlabs"]);
  });

  it("canonicalizes a voice-model alias omitted from the supplied inventory", () => {
    const inventory = [createSpeechProvider("openai")];
    const cfg = {
      agents: { defaults: { voiceModel: { primary: "edge/edge-tts" } } },
    } as OpenClawConfig;

    expect(resolveTtsProviderOrder("openai", cfg, inventory)).toEqual(["openai", "microsoft"]);
  });

  it("returns empty results when the capability runtime has no speech providers", () => {
    expect(registry.listSpeechProviders()).toStrictEqual([]);
    expect(registry.getSpeechProvider("demo-speech")).toBeUndefined();
    expect(registry.canonicalizeSpeechProviderId("demo-speech")).toBe("demo-speech");
  });
});
