export declare function writeFileSyncAtomic(params: {
    rootDir: string;
    filePath: string;
    content: string | Uint8Array;
    privateMode: boolean;
    dirMode: number;
    mode: number;
}): string;
