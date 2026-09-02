import { Command } from "commander";
import { createRegistry } from "../providers/registry.js";
import { type StartCrablineServerParams, type StartedCrablineServer } from "../servers/index.js";
type SetExitCode = (code: number) => void;
export type ReadyFileIdentity = {
    birthtimeNs: bigint;
    ctimeNs: bigint;
    dev: bigint;
    ino: bigint;
    size: bigint;
};
type ProgramDependencies = {
    acquireReadyFileLease?: (filePath: string) => Promise<() => Promise<void>>;
    createRegistry?: typeof createRegistry;
    publishReadyFile?: (filePath: string, contents: string) => Promise<ReadyFileIdentity>;
    removeReadyFile?: (filePath: string, expectedContents: string, expectedIdentity: ReadyFileIdentity) => Promise<void>;
    startServer?: (params: StartCrablineServerParams) => Promise<StartedCrablineServer>;
};
export declare function createProgram(setExitCode?: SetExitCode, dependencies?: ProgramDependencies): Command;
type ShutdownSignal = "SIGINT" | "SIGTERM";
type SignalTarget = {
    on(event: ShutdownSignal, listener: () => void): unknown;
    removeListener(event: ShutdownSignal, listener: () => void): unknown;
};
export declare function publishReadyFile(filePath: string, contents: string): Promise<ReadyFileIdentity>;
export declare function removeReadyFile(filePath: string, expectedContents: string, expectedIdentity: ReadyFileIdentity): Promise<void>;
export declare function waitForShutdown(close: () => Promise<void>, signalTarget?: SignalTarget): Promise<void>;
export declare function runCli(argv: string[]): Promise<number>;
export {};
