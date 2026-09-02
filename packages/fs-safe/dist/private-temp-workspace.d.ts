import { type FileStore, type FileStoreSync } from "./file-store.js";
import { type TempPathIdentityReceipt } from "./temp-cleanup.js";
export type TempWorkspaceCleanupResult = "removed" | "missing" | "identity-mismatch";
export type TempWorkspaceOptions = {
    rootDir: string;
    prefix: string;
    dirMode?: number;
    mode?: number;
};
export type TempWorkspace = {
    dir: string;
    identity: TempPathIdentityReceipt;
    store: FileStore;
    path(fileName: string): string;
    write(fileName: string, data: string | Uint8Array): Promise<string>;
    writeText(fileName: string, data: string): Promise<string>;
    writeJson(fileName: string, data: unknown, options?: {
        trailingNewline?: boolean;
    }): Promise<string>;
    copyIn(fileName: string, sourcePath: string): Promise<string>;
    read(fileName: string): Promise<Buffer>;
    cleanup(): Promise<TempWorkspaceCleanupResult>;
    [Symbol.asyncDispose](): Promise<void>;
};
export type TempWorkspaceSync = {
    dir: string;
    identity: TempPathIdentityReceipt;
    store: FileStoreSync;
    path(fileName: string): string;
    write(fileName: string, data: string | Uint8Array): string;
    writeText(fileName: string, data: string): string;
    writeJson(fileName: string, data: unknown, options?: {
        trailingNewline?: boolean;
    }): string;
    read(fileName: string): Buffer;
    cleanup(): TempWorkspaceCleanupResult;
    [Symbol.dispose](): void;
};
export declare function tempWorkspace(options: TempWorkspaceOptions): Promise<TempWorkspace>;
export declare function withTempWorkspace<T>(options: TempWorkspaceOptions, run: (workspace: TempWorkspace) => Promise<T>): Promise<T>;
export declare function tempWorkspaceSync(options: TempWorkspaceOptions): TempWorkspaceSync;
export declare function withTempWorkspaceSync<T>(options: TempWorkspaceOptions, run: (workspace: TempWorkspaceSync) => T): T;
