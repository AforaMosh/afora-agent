import type { NativeBinding } from "./native-binding.js";
export type { NativeBinding } from "./native-binding.js";
export declare function __loadBundledNativeForTest(): NativeBinding;
export declare function __nativeLoaderDetectorsForTest(): {
    report: boolean | undefined;
    filesystem: boolean | undefined;
    elfInterpreter: boolean | undefined;
};
export declare function __nativeTargetForTest(platform: NodeJS.Platform, arch: string, musl?: boolean): string | undefined;
export declare function getNativeBinding(): NativeBinding | undefined;
export declare function requireNativeBinding(): NativeBinding;
export declare function __setNativeLoaderForTest(loader: () => NativeBinding): void;
export declare function __resetNativeLoaderForTest(): void;
