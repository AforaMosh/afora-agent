//#region src/index.d.ts
type TerminalSize = {
  columns: number;
  rows: number;
};
type TerminalExit = {
  code: number | null;
  signal: string | number | null;
};
type TerminalOutput = {
  sessionId: string;
  bytes: Uint8Array;
};
interface TerminalDuplex {
  output: AsyncIterable<Uint8Array>;
  write?(bytes: Uint8Array): Promise<void>;
  resize?(size: TerminalSize): Promise<void>;
  close(reason?: string): Promise<void>;
}
type LibterminalErrorCode = "invalid_frame" | "unsupported_protocol" | "invalid_terminal_size" | "subscriber_overflow" | "transport_closed" | "control_revoked" | "pty_unavailable" | "ghostty_unavailable";
declare class LibterminalError extends Error {
  readonly code: LibterminalErrorCode;
  readonly cause?: unknown;
  constructor(code: LibterminalErrorCode, message: string, options?: {
    cause?: unknown;
  });
}
declare function assertTerminalSize(size: TerminalSize): TerminalSize;
//#endregion
export { LibterminalError, LibterminalErrorCode, TerminalDuplex, TerminalExit, TerminalOutput, TerminalSize, assertTerminalSize };