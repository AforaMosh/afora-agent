/**
 * Creates each missing path component from `rootReal` down to `targetPath`,
 * guarding every step. Returns the real (symlink-resolved) path of the final
 * component so callers can guard/use that path directly instead of
 * re-deriving it from the original, possibly-symlinked, lexical path.
 */
export declare function mkdirPathComponentsWithGuards(params: {
    rootReal: string;
    targetPath: string;
    beforeComponent?: (componentPath: string) => Promise<void> | void;
}): Promise<string>;
