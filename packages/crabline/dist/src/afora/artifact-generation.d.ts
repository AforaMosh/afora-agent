import type { CrablineServerManifest } from "../servers/index.js";
import { publishPrivateFileAtomically, syncParentDirectory } from "./private-file.js";
import { type AforaCrablineChannelDriverSelection } from "./shared.js";
import type { AforaCrablineSmokeRunLock } from "./smoke-lock.js";
export type AforaCrablineArtifactPointer = {
    capabilityMatrixPath: string;
    generation: string;
    manifestPath: string;
    previousGeneration?: string;
    providerReadinessArtifactPath: string;
    smokeArtifactPath: string;
    version: 1;
};
export type PublishedAforaCrablineArtifactGeneration = AforaCrablineArtifactPointer & {
    pointerPath: string;
    providerReadiness: Record<string, unknown>;
    smoke: Record<string, unknown>;
    warnings?: string[];
};
type PublishGenerationDependencies = {
    beforePointerSwitch?: (pointer: AforaCrablineArtifactPointer) => Promise<void>;
    createGenerationId?: () => string;
    platform?: NodeJS.Platform;
    publishPrivateFile?: typeof publishPrivateFileAtomically;
    secureWindowsDirectory?: (directoryPath: string) => Promise<void>;
    secureWindowsFile?: (filePath: string) => Promise<void>;
    syncParent?: typeof syncParentDirectory;
};
type RecorderSnapshot = {
    contents: string;
    fileName: string;
};
export declare function readAforaCrablineArtifactPointer(outputDir: string): Promise<AforaCrablineArtifactPointer | null>;
export declare function publishAforaCrablineArtifactGeneration(params: {
    capabilityReport: unknown;
    lock: AforaCrablineSmokeRunLock;
    manifest: CrablineServerManifest;
    outputDir: string;
    recorderSnapshot?: RecorderSnapshot;
    selection: AforaCrablineChannelDriverSelection;
    providerReadiness: Record<string, unknown>;
}, dependencies?: PublishGenerationDependencies): Promise<PublishedAforaCrablineArtifactGeneration>;
export {};
