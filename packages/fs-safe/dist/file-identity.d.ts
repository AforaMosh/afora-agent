export type FileIdentityStat = {
    dev: number | bigint;
    ino: number | bigint;
};
export declare function sha256Hex(data: string | Buffer, encoding?: BufferEncoding): string;
export declare function sameFileIdentity(left: FileIdentityStat, right: FileIdentityStat, platform?: NodeJS.Platform): boolean;
