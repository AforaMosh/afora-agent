import { TerminalDuplex, TerminalExit, TerminalSize } from "./index.js";
import { n as GhosttyAsset, t as GHOSTTY_ASSET_PATHS } from "./ghostty-assets-BTTeteW3.js";
//#region src/node.d.ts
type DisposableLike = {
  dispose(): void;
};
type PtyProcessLike = {
  onData(listener: (data: string) => void): DisposableLike;
  onExit(listener: (event: {
    exitCode: number;
    signal?: number;
  }) => void): DisposableLike;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
};
type PtySpawnOptions = {
  name: string;
  columns: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
};
type PtyDriver = {
  spawn(command: string, args: string[], options: PtySpawnOptions): PtyProcessLike;
};
type SpawnLocalPtyOptions = {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  name?: string;
  size?: TerminalSize;
  driver?: PtyDriver;
  signal?: AbortSignal;
  onOutput?: (bytes: Uint8Array) => void;
  outputBufferBytes?: number;
  onOutputDrop?: (droppedBytes: number) => void;
};
type LocalPtySession = TerminalDuplex & {
  readonly exit: Promise<TerminalExit>;
  kill(signal?: string): void;
};
type AttachLocalStdioOptions = {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  signal?: AbortSignal;
  onResize?: (size: TerminalSize) => void;
};
declare function loadNodePtyDriver(): Promise<PtyDriver>;
declare function spawnLocalPty(options: SpawnLocalPtyOptions): Promise<LocalPtySession>;
declare function attachLocalStdio(terminal: TerminalDuplex, options?: AttachLocalStdioOptions): Promise<void>;
declare function ensureNodePtySpawnHelperExecutable(): Promise<void>;
declare function readGhosttyAsset(pathname: string): Promise<GhosttyAsset | null>;
//#endregion
export { AttachLocalStdioOptions, DisposableLike, GHOSTTY_ASSET_PATHS, type GhosttyAsset, LocalPtySession, PtyDriver, PtyProcessLike, PtySpawnOptions, SpawnLocalPtyOptions, attachLocalStdio, ensureNodePtySpawnHelperExecutable, loadNodePtyDriver, readGhosttyAsset, spawnLocalPty };