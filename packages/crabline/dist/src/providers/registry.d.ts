import type { ManifestDefinition } from "../config/schema.js";
import { AFORA_SUPPORT_CATALOG } from "./catalog.js";
import type { InboundEnvelope, ProbeResult, ProviderAdapter, ProviderContext, ProviderSupportStatus, SendContext, SendResult, WaitContext, WatchContext } from "./types.js";
export type Registry = {
    catalog: typeof AFORA_SUPPORT_CATALOG;
    resolve(providerId: string, fixtureId: string): ProviderAdapter;
};
type ProviderFactory = () => Promise<ProviderAdapter>;
export declare class LazyProviderAdapter implements ProviderAdapter {
    #private;
    readonly id: string;
    readonly platform: "bluebubbles" | "discord" | "feishu" | "googlechat" | "imessage" | "irc" | "line" | "loopback" | "matrix" | "mattermost" | "msteams" | "nextcloudtalk" | "nostr" | "signal" | "slack" | "synologychat" | "telegram" | "tlon" | "twitch" | "webchat" | "whatsapp" | "zalo" | "zalouser";
    readonly status: ProviderSupportStatus;
    readonly supports: readonly ("agent" | "probe" | "roundtrip" | "send")[];
    constructor(params: {
        adapterName: string;
        factory: ProviderFactory;
        id: string;
        normalizeTarget: ProviderAdapter["normalizeTarget"];
        platform: ProviderAdapter["platform"];
        status: ProviderSupportStatus;
        supports: ProviderAdapter["supports"];
    });
    normalizeTarget(target: ProviderContext["fixture"]["target"]): import("./types.js").NormalizedTarget;
    probe(context: ProviderContext): Promise<ProbeResult>;
    send(context: SendContext): Promise<SendResult>;
    waitForInbound(context: WaitContext): Promise<InboundEnvelope | null>;
    watch(context: WatchContext): AsyncIterable<InboundEnvelope>;
    cleanup(): Promise<void>;
}
export declare function createRegistry(manifest: ManifestDefinition, manifestPath: string): Registry;
export {};
