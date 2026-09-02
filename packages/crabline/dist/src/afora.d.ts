import { type CrablineServerChannel, type CrablineServerManifest, type StartCrablineServerParams, type StartedCrablineServer } from "./servers/index.js";
import { AFORA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH, AFORA_CRABLINE_CHANNEL_SMOKE_PATH, AFORA_CRABLINE_PROVIDER_READINESS_PATH, AFORA_CRABLINE_DEFAULT_CHANNEL, AFORA_CRABLINE_ARTIFACT_POINTER_PATH, AFORA_CRABLINE_ARTIFACT_STORE_DIRECTORY, AFORA_CRABLINE_MANIFEST_PATH, type AforaCrablineAgentDelivery, type AforaCrablineChannelDriverSelection, type AforaCrablineProviderReadinessResult, type AforaCrablineGatewayBinding, type AforaCrablineInbound, type AforaCrablineInboundInput, type AforaCrablineOutboundMessage, type AforaCrablineProviderAdapter, type StartedAforaCrablineAdapter, type StartAforaCrablineAdapterParams } from "./afora/shared.js";
export { AFORA_CRABLINE_ARTIFACT_POINTER_PATH, AFORA_CRABLINE_ARTIFACT_STORE_DIRECTORY, AFORA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH, AFORA_CRABLINE_CHANNEL_SMOKE_PATH, AFORA_CRABLINE_PROVIDER_READINESS_PATH, AFORA_CRABLINE_DEFAULT_CHANNEL, AFORA_CRABLINE_MANIFEST_PATH, };
export type { AforaCrablineAgentDelivery, AforaCrablineChannelDriverSelection, AforaCrablineChannelDriverSmokeResult, AforaCrablineProviderReadinessResult, AforaCrablineConversation, AforaCrablineGatewayBinding, AforaCrablineInbound, AforaCrablineInboundInput, AforaCrablineOutboundMessage, StartedAforaCrablineAdapter, StartAforaCrablineAdapterParams, } from "./afora/shared.js";
declare function createAforaCrablineProviderAdapter(manifest: CrablineServerManifest): AforaCrablineProviderAdapter;
export declare function resolveAforaCrablineChannel(input?: string | null): CrablineServerChannel;
export declare function resolveAforaCrablineChannelDriverSelection(params: {
    channel?: string | null;
}): AforaCrablineChannelDriverSelection & {
    providerReadinessArtifactPath: typeof AFORA_CRABLINE_PROVIDER_READINESS_PATH;
};
export declare function probeAforaCrablineProvider(manifest: CrablineServerManifest): Promise<unknown>;
export declare function createAforaCrablineProviderBinding(manifest: CrablineServerManifest): AforaCrablineGatewayBinding;
export declare function createAforaCrablineAgentDelivery(params: {
    manifest: CrablineServerManifest;
    target: string;
}): AforaCrablineAgentDelivery;
export declare function createAforaCrablineInbound(params: {
    input: AforaCrablineInboundInput;
    manifest: CrablineServerManifest;
}): AforaCrablineInbound;
export declare function createAforaCrablineOutboundFromRecorderEvent(params: {
    event: unknown;
    manifest: CrablineServerManifest;
    targetByProviderTarget: ReadonlyMap<string, string>;
}): AforaCrablineOutboundMessage | null;
export declare function startAforaCrablineAdapter(params: StartAforaCrablineAdapterParams, dependencies?: {
    createProviderAdapter?: typeof createAforaCrablineProviderAdapter;
    startServer?: (params: StartCrablineServerParams) => Promise<StartedCrablineServer>;
}): Promise<StartedAforaCrablineAdapter>;
export declare function runAforaCrablineProviderReadiness(params: {
    outputDir: string;
    selection: AforaCrablineChannelDriverSelection;
}): Promise<AforaCrablineProviderReadinessResult>;
/** @deprecated Use runAforaCrablineProviderReadiness. */
export declare const runAforaCrablineChannelDriverSmoke: typeof runAforaCrablineProviderReadiness;
export declare function createAforaCrablineChannelReportNotes(selection: AforaCrablineChannelDriverSelection | null | undefined): string[];
