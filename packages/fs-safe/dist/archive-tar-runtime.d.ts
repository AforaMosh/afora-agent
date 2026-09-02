export type TarParserEntry = {
    meta?: boolean;
    size: number;
    type?: string;
    resume(): void;
};
export type TarParser = NodeJS.WritableStream & {
    abort(error: Error): void;
    on(event: "ignoredEntry", listener: (entry: TarParserEntry) => void): TarParser;
    on(event: "entry", listener: (entry: TarParserEntry) => void): TarParser;
    on(event: "meta", listener: (metadata: string) => void): TarParser;
    on(event: "error", listener: (error: Error) => void): TarParser;
    on(event: "end", listener: () => void): TarParser;
};
export type TarModule = {
    Parser: new (options: {
        strict: true;
        maxMetaEntrySize: number;
    }) => TarParser;
    x(options: {
        cwd: string;
        strip: number;
        gzip?: boolean;
        signal?: AbortSignal;
        preservePaths: false;
        noChmod: true;
        preserveOwner: false;
        strict: true;
        maxMetaEntrySize: number;
        filter?(this: TarParser, entryPath: string, entry: unknown): boolean;
        onReadEntry(this: unknown, entry: unknown): void;
    }): TarParser;
    t(options: {
        file: string;
        strict: true;
        maxMetaEntrySize: number;
        onReadEntry(entry: AsyncIterable<unknown> & {
            resume(): void;
        }): void;
    }): Promise<unknown>;
};
export declare function importOptionalTar(): Promise<TarModule>;
export declare function normalizeTarParserError(error: unknown): unknown;
