import type { ServerRequestEvent } from "./http.js";
export type ServerEventObserver = (event: ServerRequestEvent) => void | Promise<void>;
export declare function recordServerEvent(params: {
    event: ServerRequestEvent;
    onEvent: ServerEventObserver | undefined;
    recorderPath: string;
}): Promise<void>;
export declare function recordCommittedServerEvent(params: {
    event: ServerRequestEvent;
    onEvent: ServerEventObserver | undefined;
    recorderPath: string;
}): Promise<void>;
