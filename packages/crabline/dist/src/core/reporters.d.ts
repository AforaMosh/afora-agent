import type { CommandRunResult, SuiteRunResult } from "./run.js";
export declare function sanitizeTerminalText(value: string, singleLine?: boolean): string;
export declare function formatRunResultText(result: CommandRunResult | SuiteRunResult): string;
export declare function formatJson(result: unknown): string;
