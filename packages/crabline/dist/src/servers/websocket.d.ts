import { type WebSocketServer } from "ws";
export declare function closeWebSocketServer(server: WebSocketServer, graceMs?: number): Promise<void>;
