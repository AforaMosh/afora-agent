import type { InboundEnvelope } from "./types.js";
export type RecordableInboundEnvelope = InboundEnvelope & {
    recordedDirection?: "inbound" | "outbound";
};
export type RecordedInboundEnvelope = RecordableInboundEnvelope & {
    recordedAt: string;
};
type IncrementalReadState = {
    caughtUp: boolean;
    continuity: Buffer;
    generation: number;
    identity: {
        dev: number;
        ino: number;
    } | undefined;
    offset: number;
    pending: Buffer;
};
export type RecordedInboundCursor = {
    buffered: RecordedInboundEnvelope[];
    readState: IncrementalReadState;
    seen: Set<string>;
};
export declare function createRecordedInboundCursor(): RecordedInboundCursor;
export declare function cloneRecordedInboundCursor(cursor: RecordedInboundCursor): RecordedInboundCursor;
export declare function appendRecordedInbound(filePath: string, event: RecordableInboundEnvelope): Promise<RecordedInboundEnvelope>;
export declare function appendRecordedInboundBatch(filePath: string, events: InboundEnvelope[]): Promise<RecordedInboundEnvelope[]>;
export declare function readRecordedInbound(filePath: string): Promise<RecordedInboundEnvelope[]>;
export declare function waitForRecordedInbound(params: {
    cursor?: RecordedInboundCursor | undefined;
    filePath: string;
    matches: (event: RecordedInboundEnvelope) => boolean;
    pollMs?: number;
    recordedDirection?: "inbound" | "outbound" | undefined;
    signal?: AbortSignal | undefined;
    since?: string | undefined;
    timeoutMs: number;
}): Promise<RecordedInboundEnvelope | null>;
export declare function watchRecordedInbound(params: {
    filePath: string;
    matches: (event: RecordedInboundEnvelope) => boolean;
    pollMs?: number;
    recordedDirection?: "inbound" | "outbound" | undefined;
    signal?: AbortSignal | undefined;
    since?: string | undefined;
}): AsyncIterable<RecordedInboundEnvelope>;
export {};
