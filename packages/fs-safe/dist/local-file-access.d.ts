export declare function isFileUrl(input: string): boolean;
export declare function hasEncodedFileUrlSeparator(pathname: string): boolean;
export declare function isWindowsNetworkPath(filePath: string, platform?: NodeJS.Platform): boolean;
export declare function isWindowsDriveLetterPath(filePath: string, platform?: NodeJS.Platform): boolean;
export declare function assertNoWindowsNetworkPath(filePath: string, label?: string): void;
export declare function safeFileURLToPath(fileUrl: string, platform?: NodeJS.Platform): string;
export declare function trySafeFileURLToPath(fileUrl: string, platform?: NodeJS.Platform): string | undefined;
export declare function basenameFromMediaSource(source?: string): string | undefined;
