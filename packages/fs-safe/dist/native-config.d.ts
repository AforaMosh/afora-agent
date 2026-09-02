export type FsSafeNativeMode = "auto" | "off" | "require";
export type FsSafeNativeConfig = {
    mode: FsSafeNativeMode;
};
/** @deprecated Compatibility bridge for 0.4 upgrades. Use {@link FsSafeNativeConfig}. */
export type FsSafePythonConfig = {
    mode: FsSafeNativeMode;
    pythonPath?: string;
};
export declare function configureFsSafeNative(config: Partial<FsSafeNativeConfig>): void;
/**
 * @deprecated Compatibility bridge for 0.4 upgrades. Use configureFsSafeNative.
 */
export declare function configureFsSafePython(config: Partial<FsSafePythonConfig>): void;
export declare function getFsSafeNativeConfig(): FsSafeNativeConfig;
export declare function __resetFsSafeNativeConfigForTest(): void;
