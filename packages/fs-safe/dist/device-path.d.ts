export type UnsafeDeviceReadPathReason = "posix-device" | "posix-fd" | "windows-device";
export type UnsafeDeviceReadPathMatch = {
    path: string;
    reason: UnsafeDeviceReadPathReason;
};
export type UnsafeDeviceReadPathOptions = {
    cwd?: string;
    platform?: NodeJS.Platform;
};
export declare const WINDOWS_RESERVED_DEVICE_NAMES: ReadonlySet<string>;
export declare function matchUnsafeDeviceReadPath(filePath: string, options?: UnsafeDeviceReadPathOptions): UnsafeDeviceReadPathMatch | undefined;
export declare function isUnsafeDeviceReadPath(filePath: string, options?: UnsafeDeviceReadPathOptions): boolean;
export declare function assertNoUnsafeDeviceReadPath(filePath: string, options?: UnsafeDeviceReadPathOptions): void;
