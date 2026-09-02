import { TerminalSize } from "./index.js";
//#region src/protocol.d.ts
declare const TERMINAL_WS_MAGIC = 22851;
declare const TERMINAL_WS_VERSION = 2;
declare const DEFAULT_MAX_TERMINAL_FRAME_BYTES: number;
declare const DEFAULT_MAX_SESSION_ID_BYTES = 4096;
declare const TerminalMessageType: {
  readonly Hello: 1;
  readonly Welcome: 2;
  readonly Subscribe: 10;
  readonly Unsubscribe: 11;
  readonly Output: 20;
  readonly Snapshot: 21;
  readonly Event: 22;
  readonly Error: 23;
  readonly Input: 30;
  readonly Key: 31;
  readonly Resize: 32;
  readonly Stop: 33;
  readonly ControlRequest: 50;
  readonly ControlDecision: 51;
  readonly ControlGranted: 52;
  readonly ControlRevoked: 53;
  readonly Ping: 60;
  readonly Pong: 61;
  readonly Ack: 62;
};
type TerminalMessageType = (typeof TerminalMessageType)[keyof typeof TerminalMessageType];
declare const TerminalSubscribeFlags: {
  readonly Output: number;
  readonly Snapshot: number;
  readonly Events: number;
  readonly OutputAcknowledgements: number;
};
type TerminalFrame = {
  type: TerminalMessageType;
  sessionId: string;
  payload: Uint8Array;
};
type TerminalFrameLimits = {
  maxFrameBytes?: number;
  maxSessionIdBytes?: number;
};
type TerminalSubscribe = {
  flags: number;
  snapshotMinIntervalMs: number;
  snapshotMaxIntervalMs: number;
  columns: number;
  rows: number;
};
declare function encodeTerminalFrame(params: {
  type: TerminalMessageType;
  sessionId?: string;
  payload?: Uint8Array;
}, limits?: TerminalFrameLimits): Uint8Array;
declare function decodeTerminalFrame(data: Uint8Array, limits?: TerminalFrameLimits): TerminalFrame;
declare function tryDecodeTerminalFrame(data: Uint8Array, limits?: TerminalFrameLimits): TerminalFrame | null;
declare function encodeSubscribePayload(params: {
  flags: number;
  snapshotMinIntervalMs?: number;
  snapshotMaxIntervalMs?: number;
  columns: number;
  rows: number;
}): Uint8Array;
declare function decodeSubscribePayload(payload: Uint8Array): TerminalSubscribe;
declare function encodeResizePayload(size: TerminalSize): Uint8Array;
declare function decodeResizePayload(payload: Uint8Array): TerminalSize;
declare function encodeAckPayload(bytes: number): Uint8Array;
declare function decodeAckPayload(payload: Uint8Array): number;
declare function encodeJsonPayload(value: unknown): Uint8Array;
declare function decodeJsonPayload(payload: Uint8Array): unknown;
//#endregion
export { DEFAULT_MAX_SESSION_ID_BYTES, DEFAULT_MAX_TERMINAL_FRAME_BYTES, TERMINAL_WS_MAGIC, TERMINAL_WS_VERSION, TerminalFrame, TerminalFrameLimits, TerminalMessageType, TerminalSubscribe, TerminalSubscribeFlags, decodeAckPayload, decodeJsonPayload, decodeResizePayload, decodeSubscribePayload, decodeTerminalFrame, encodeAckPayload, encodeJsonPayload, encodeResizePayload, encodeSubscribePayload, encodeTerminalFrame, tryDecodeTerminalFrame };