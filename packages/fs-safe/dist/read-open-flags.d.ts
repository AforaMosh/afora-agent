import fs from "node:fs";
type ReadOpenFlagConstants = Pick<typeof fs.constants, "O_RDONLY"> & Partial<Pick<typeof fs.constants, "O_NOFOLLOW" | "O_NONBLOCK">>;
export declare function resolveReadOpenFlags(options?: {
    constants?: ReadOpenFlagConstants;
    followSymlinks?: boolean;
}): number;
export {};
