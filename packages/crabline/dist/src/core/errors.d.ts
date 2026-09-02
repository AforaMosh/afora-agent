import { type ExitCode } from "./exit-codes.js";
export type FailureKind = "config" | "auth" | "connectivity" | "outbound" | "inbound" | "timeout" | "assertion";
export declare class CrablineError extends Error {
    readonly exitCode: ExitCode;
    readonly kind: FailureKind | undefined;
    constructor(message: string, options?: {
        cause?: unknown;
        exitCode?: ExitCode;
        kind?: FailureKind;
    });
}
export declare function ensureErrorMessage(error: unknown): string;
