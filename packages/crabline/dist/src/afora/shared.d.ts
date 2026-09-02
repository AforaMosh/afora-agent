import type { CrablineServerChannel, CrablineServerManifest } from "../servers/index.js";
import type { ServerEventObserver } from "../servers/recorder.js";
export declare const DEFAULT_ACCOUNT_ID = "default";
export declare const AFORA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH = "crabline-fake-provider-capabilities.json";
export declare const AFORA_CRABLINE_PROVIDER_READINESS_PATH = "crabline-fake-provider-smoke.json";
/** @deprecated Use AFORA_CRABLINE_PROVIDER_READINESS_PATH. */
export declare const AFORA_CRABLINE_CHANNEL_SMOKE_PATH = "crabline-fake-provider-smoke.json";
export declare const AFORA_CRABLINE_MANIFEST_PATH = "crabline-fake-provider-server.json";
export declare const AFORA_CRABLINE_ARTIFACT_STORE_DIRECTORY = ".crabline-smoke-artifacts";
export declare const AFORA_CRABLINE_ARTIFACT_POINTER_PATH = ".crabline-smoke-artifacts/current.json";
export declare const AFORA_CRABLINE_DEFAULT_CHANNEL = "telegram";
export type AforaCrablineChannelDriverSelection = {
    channel: CrablineServerChannel;
    channelDriver: "crabline";
    capabilityMatrixPath: typeof AFORA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH;
    providerReadinessArtifactPath?: typeof AFORA_CRABLINE_PROVIDER_READINESS_PATH;
    smokeArtifactPath: typeof AFORA_CRABLINE_CHANNEL_SMOKE_PATH;
};
/** @deprecated Use AforaCrablineProviderReadinessResult. */
export type AforaCrablineChannelDriverSmokeResult = {
    artifactPointerPath: string;
    capabilityReport: unknown;
    capabilityMatrixPath: string;
    generation: string;
    manifestPath: string;
    smoke: unknown;
    smokeArtifactPath: string;
    warnings?: string[];
};
export type AforaCrablineProviderReadinessResult = AforaCrablineChannelDriverSmokeResult & {
    providerReadiness: unknown;
    providerReadinessArtifactPath: string;
};
export type AforaCrablineConversation = {
    id: string;
    kind: "direct" | "group";
};
export type AforaCrablineGatewayBinding = {
    accountId: string;
    channel: string;
    createChannelDriverSmokeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
    createGatewayConfig(aforaConfig?: Record<string, unknown>): Record<string, unknown>;
    requiredPluginIds: string[];
};
export type AforaCrablineAgentDelivery = {
    channel: string;
    replyChannel: string;
    replyTo: string;
    to: string;
};
export type AforaCrablineInboundInput = {
    conversation: {
        id: string;
        kind: "direct" | "group";
    };
    senderId: string;
    senderName?: string | undefined;
    text: string;
    threadId?: string | undefined;
    nativeCommand?: {
        name: string;
    } | undefined;
};
export type AforaCrablineInbound = {
    providerBody: Record<string, unknown>;
    providerHeaders: Record<string, string>;
    providerTargetKey: string;
    providerUrl: string;
    qaTarget: string;
    stateConversation: AforaCrablineConversation;
    threadId?: string | undefined;
};
export type AforaCrablineOutboundMessage = {
    accountId: string;
    senderId: string;
    senderName: string;
    text: string;
    to: string;
};
export type StartAforaCrablineAdapterParams = {
    channel: CrablineServerChannel;
    onEvent?: ServerEventObserver | undefined;
    aforaConfig?: Record<string, unknown> | undefined;
    recorderPath?: string | undefined;
};
export type StartedAforaCrablineAdapter = AforaCrablineGatewayBinding & {
    close(): Promise<void>;
    createAgentDelivery(params: {
        target: string;
    }): AforaCrablineAgentDelivery;
    createInbound(params: {
        input: AforaCrablineInboundInput;
    }): AforaCrablineInbound;
    createOutboundFromRecorderEvent(params: {
        event: unknown;
        targetByProviderTarget: ReadonlyMap<string, string>;
    }): AforaCrablineOutboundMessage | null;
    manifest: CrablineServerManifest;
    probe(): Promise<unknown>;
};
export type ParsedQaTarget = {
    kind: "direct" | "group";
    id: string;
    native: boolean;
    threadId?: string;
};
export type AforaCrablineProviderAdapter = {
    createAgentDelivery(parsed: ParsedQaTarget): AforaCrablineAgentDelivery;
    createBinding(): AforaCrablineGatewayBinding;
    createInbound(input: AforaCrablineInboundInput): AforaCrablineInbound;
    createOutboundFromRecorderEvent(params: {
        event: unknown;
        targetByProviderTarget: ReadonlyMap<string, string>;
    }): AforaCrablineOutboundMessage | null;
    probe(signal?: AbortSignal): Promise<unknown>;
};
export type AforaCrablineProviderBridge<TManifest extends CrablineServerManifest = CrablineServerManifest> = {
    createAdapter(manifest: TManifest): AforaCrablineProviderAdapter;
    createAdapterFromManifest(manifest: CrablineServerManifest): AforaCrablineProviderAdapter;
    provider: TManifest["provider"];
};
export type AforaCrablineProviderBridgeRegistry = {
    [Provider in CrablineServerManifest["provider"]]: AforaCrablineProviderBridge<Extract<CrablineServerManifest, {
        provider: Provider;
    }>>;
};
export declare function createAforaCrablineProviderBridge<TProvider extends CrablineServerManifest["provider"]>(params: {
    createAdapter(manifest: Extract<CrablineServerManifest, {
        provider: TProvider;
    }>): AforaCrablineProviderAdapter;
    provider: TProvider;
}): AforaCrablineProviderBridge<Extract<CrablineServerManifest, {
    provider: TProvider;
}>>;
export declare function runAforaCrablineProviderProbe<T>(provider: CrablineServerManifest["provider"], probe: (signal: AbortSignal) => Promise<T>): Promise<T>;
export declare function readString(value: unknown): string | undefined;
export declare function readNonBlankString(value: unknown): string | undefined;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function readInteger(value: unknown): number | undefined;
export declare function parseQaTarget(target: string): ParsedQaTarget;
export declare function canonicalConversationIdForInbound(input: AforaCrablineInboundInput): string;
export declare function qaTargetForInbound(input: AforaCrablineInboundInput): string;
export declare function createAdminInboundRequest(manifest: CrablineServerManifest): {
    providerHeaders: {
        "content-type": string;
        "x-crabline-admin-token": string;
    };
    providerUrl: string;
};
