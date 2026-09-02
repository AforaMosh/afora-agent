import { type FailureKind } from "./errors.js";
import { type ExitCode } from "./exit-codes.js";
import type { ManifestDefinition } from "../config/schema.js";
import type { Registry } from "../providers/registry.js";
export type CommandRunResult = {
    diagnostics: string[];
    exitCode?: ExitCode | undefined;
    failureKind?: FailureKind | undefined;
    fixtureId: string;
    mode: string;
    nonce?: string | undefined;
    ok: boolean;
    providerId: string;
};
export type SuiteRunResult = {
    results: CommandRunResult[];
    totalPassed: number;
};
export declare function assertScriptStdinPayloadSize(payload: unknown): void;
export declare function runFixtureCommand(params: {
    fixtureId: string;
    manifest: ManifestDefinition;
    manifestPath: string;
    modeOverride?: "agent" | "probe" | "roundtrip" | "send";
    registry: Registry;
}): Promise<CommandRunResult>;
export declare function runSuite(params: {
    fixtureIds: string[];
    manifest: ManifestDefinition;
    manifestPath: string;
    registry: Registry;
}): Promise<SuiteRunResult>;
export declare function computeExitCode(result: CommandRunResult | SuiteRunResult): number;
