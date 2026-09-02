import { TerminalSize } from "./index.js";
import { TerminalFrame, TerminalFrameLimits, TerminalMessageType } from "./protocol.js";
import { Ghostty, ITerminalOptions, Terminal } from "ghostty-web";
//#region src/browser-color-query.d.ts
type TerminalDefaultColors = Readonly<{
  foreground: string;
  background: string;
  cursor: string;
}>;
type TerminalDefaultColorQueryResponder = {
  /** Observes live terminal output and replies to complete default-color queries. */
  observe(data: string): void;
  /** Resets parser state from an authoritative replay without answering historical queries. */
  primeFromReplay(data: string): void;
};
type TerminalDefaultColorQueryResponderOptions = {
  getColors: () => TerminalDefaultColors;
  reply: (data: string) => void;
};
/**
 * Answers streamed OSC 10-12 dynamic-color queries for browser terminals whose
 * emulator does not emit those replies. Color values must use `#rrggbb` syntax.
 */
declare function createTerminalDefaultColorQueryResponder(options: TerminalDefaultColorQueryResponderOptions): TerminalDefaultColorQueryResponder;
//#endregion
//#region src/browser.d.ts
type GhosttyRuntime = {
  ghostty: Ghostty;
  Terminal: typeof import("ghostty-web").Terminal;
  FitAddon: typeof import("ghostty-web").FitAddon;
};
type GhosttyRuntimeOptions = {
  wasmUrl?: string;
  module?: typeof import("ghostty-web");
};
type GhosttyTerminalStatus = {
  state: "loading";
} | {
  state: "ready";
} | {
  state: "ended";
} | {
  state: "error";
  error: unknown;
};
type CreateGhosttyTerminalOptions = {
  parent: HTMLElement;
  runtime?: GhosttyRuntime;
  runtimeOptions?: GhosttyRuntimeOptions;
  terminalOptions?: Omit<ITerminalOptions, "disableStdin" | "ghostty">;
  size?: TerminalSize;
  readOnly?: boolean;
  autoFit?: boolean;
  signal?: AbortSignal;
  onData?: (bytes: Uint8Array) => void;
  onResize?: (size: TerminalSize) => void;
  onStatus?: (status: GhosttyTerminalStatus) => void;
};
type GhosttyTerminalController = {
  readonly terminal: Terminal;
  readonly readOnly: boolean;
  write(bytes: Uint8Array): void;
  resize(size: TerminalSize): void;
  fit(): void;
  setReadOnly(readOnly: boolean): void;
  attach(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void>;
  dispose(): void;
};
type TerminalHubWebSocket = {
  readonly readyState: number;
  binaryType?: string;
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: {
    data: unknown;
  }) => void): void;
  addEventListener(type: "close", listener: (event: {
    code?: number;
    reason?: string;
  }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: {
    data: unknown;
  }) => void): void;
  removeEventListener(type: "close", listener: (event: {
    code?: number;
    reason?: string;
  }) => void): void;
  removeEventListener(type: "error", listener: () => void): void;
};
type TerminalHubClientOptions = {
  url: string | (() => string);
  frameLimits?: TerminalFrameLimits;
  reconnectDelayMs?: number;
  shouldReconnect?: () => boolean;
  socketFactory?: (url: string) => TerminalHubWebSocket;
  onOpen?: () => void;
  onFrame?: (frame: TerminalFrame) => void;
  onClose?: (event: {
    code?: number;
    reason?: string;
  }) => void;
  onError?: (error?: unknown) => void;
};
declare function loadGhosttyRuntime(options?: GhosttyRuntimeOptions): Promise<GhosttyRuntime>;
declare function createGhosttyTerminal(options: CreateGhosttyTerminalOptions): Promise<GhosttyTerminalController>;
declare function attachTerminalStream(target: Pick<Terminal, "write">, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void>;
declare class TerminalHubClient {
  private readonly options;
  private socket;
  private reconnectTimer;
  private closedByCaller;
  constructor(options: TerminalHubClientOptions);
  get isOpen(): boolean;
  connect(): void;
  send(params: {
    type: TerminalMessageType;
    sessionId?: string;
    payload?: Uint8Array;
  }): boolean;
  close(code?: number, reason?: string): void;
  private handleOpen;
  private handleMessage;
  private handleClose;
  private handleError;
  private resolveUrl;
  private scheduleReconnect;
  private shouldReconnect;
  private clearReconnectTimer;
  private notify;
  private reportError;
}
//#endregion
export { CreateGhosttyTerminalOptions, GhosttyRuntime, GhosttyRuntimeOptions, GhosttyTerminalController, GhosttyTerminalStatus, type TerminalDefaultColorQueryResponder, type TerminalDefaultColorQueryResponderOptions, type TerminalDefaultColors, TerminalHubClient, TerminalHubClientOptions, TerminalHubWebSocket, attachTerminalStream, createGhosttyTerminal, createTerminalDefaultColorQueryResponder, loadGhosttyRuntime };