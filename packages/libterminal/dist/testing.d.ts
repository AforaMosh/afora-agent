import { TerminalDuplex, TerminalSize } from "./index.js";
import { WebSocketCloseEventLike, WebSocketLike, WebSocketMessageEventLike, WebSocketPayload } from "./worker.js";
//#region src/testing.d.ts
declare const LIBTERMINAL_EXPORTS: readonly ["@afora/libterminal", "@afora/libterminal/protocol", "@afora/libterminal/stream", "@afora/libterminal/browser", "@afora/libterminal/node", "@afora/libterminal/worker", "@afora/libterminal/worker-assets", "@afora/libterminal/testing"];
type FakeTerminalDuplex = TerminalDuplex & {
  readonly writes: Uint8Array[];
  readonly sizes: TerminalSize[];
  readonly closeReasons: Array<string | undefined>;
  emitOutput(bytes: Uint8Array): void;
  endOutput(): void;
};
declare function createFakeTerminalDuplex(): FakeTerminalDuplex;
declare class FakeWebSocket implements WebSocketLike {
  readyState: number;
  readonly sent: WebSocketPayload[];
  closed?: {
    code?: number;
    reason?: string;
  };
  private readonly messages;
  private readonly closes;
  private readonly errors;
  send(data: WebSocketPayload): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", listener: ((event: WebSocketMessageEventLike) => void) | ((event: WebSocketCloseEventLike) => void) | (() => void)): void;
  removeEventListener(type: "message" | "close" | "error", listener: ((event: WebSocketMessageEventLike) => void) | ((event: WebSocketCloseEventLike) => void) | (() => void)): void;
  receive(data: unknown): void;
  emitClose(code?: number, reason?: string): void;
  emitError(): void;
}
declare class ManualClock {
  private currentTime;
  private nextId;
  private readonly tasks;
  now(): number;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
  advanceBy(durationMs: number): void;
  private nextTask;
}
declare function terminalBytes(value: string): Uint8Array;
declare function terminalText(chunks: Iterable<Uint8Array>): string;
declare function collectTerminalOutput(output: AsyncIterable<Uint8Array>, limit?: number): Promise<Uint8Array[]>;
//#endregion
export { FakeTerminalDuplex, FakeWebSocket, LIBTERMINAL_EXPORTS, ManualClock, collectTerminalOutput, createFakeTerminalDuplex, terminalBytes, terminalText };