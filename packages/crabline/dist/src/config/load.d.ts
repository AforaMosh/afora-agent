import { type ManifestDefinition } from "./schema.js";
export declare function resolveConfigPath(explicitPath?: string): Promise<string>;
export declare function loadManifest(configPath?: string): Promise<{
    manifest: ManifestDefinition;
    path: string;
}>;
