export declare function writeExternalFileViaSibling<T>(params: {
    finalPath: string;
    write: (filePath: string) => Promise<T>;
    fallbackFileName?: string;
    maxBytes?: number;
    mode?: number;
}): Promise<T>;
