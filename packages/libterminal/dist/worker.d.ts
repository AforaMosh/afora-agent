//#region src/worker.d.ts
declare const WEB_SOCKET_CONNECTING = 0;
declare const WEB_SOCKET_OPEN = 1;
type WebSocketPayload = string | ArrayBuffer;
type WebSocketMessageEventLike = {
  data: unknown;
};
type WebSocketCloseEventLike = {
  code?: number;
  reason?: string;
};
type WebSocketLike = {
  readonly readyState: number;
  send(data: WebSocketPayload): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: WebSocketMessageEventLike) => void): void;
  addEventListener(type: "close", listener: (event: WebSocketCloseEventLike) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: WebSocketMessageEventLike) => void): void;
  removeEventListener(type: "close", listener: (event: WebSocketCloseEventLike) => void): void;
  removeEventListener(type: "error", listener: () => void): void;
};
type WebSocketBridgeOptions = {
  canSendLeft?: () => Promise<boolean>;
  reconcileSubscription?: () => void;
  deniedReason?: string;
  controlCheckIntervalMs?: number;
  forwardRightOutputAcknowledgements?: boolean;
  acknowledgeRightOutputImmediately?: boolean;
  sanitizeCloseReason?: (reason: string) => string;
  onError?: (error: unknown) => void;
};
type WebSocketBridge = {
  readonly completed: Promise<void>;
  readonly rightOutputAcknowledgementBytes: number;
  revalidateControl(): Promise<boolean>;
  close(code?: number, reason?: string): void;
};
declare function bridgeWebSockets(left: WebSocketLike, right: WebSocketLike, options?: WebSocketBridgeOptions): WebSocketBridge;
declare function terminalOutputAcknowledgements(value: string): boolean;
declare function decodeOutputAcknowledgement(value: WebSocketPayload): number | null;
declare function terminalMessageByteLength(value: WebSocketPayload): number;
declare function sendOutputAcknowledgement(socket: WebSocketLike, bytes: number): void;
declare function normalizeWebSocketMessageData(data: unknown): Promise<WebSocketPayload>;
//#endregion
export { WEB_SOCKET_CONNECTING, WEB_SOCKET_OPEN, WebSocketBridge, WebSocketBridgeOptions, WebSocketCloseEventLike, WebSocketLike, WebSocketMessageEventLike, WebSocketPayload, bridgeWebSockets, decodeOutputAcknowledgement, normalizeWebSocketMessageData, sendOutputAcknowledgement, terminalMessageByteLength, terminalOutputAcknowledgements };