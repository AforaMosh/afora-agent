import { type NativeIdRule } from "../native-ids.js";
import type { InboundEnvelope } from "../types.js";
export type { NativeIdRule } from "../native-ids.js";
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function createSecretVerifier(expected: string): (candidate: string | null) => boolean;
export declare function optionalRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined;
export declare function optionalString(value: Record<string, unknown>, key: string): string | undefined;
export declare function optionalNumberString(value: Record<string, unknown>, key: string): string | undefined;
export declare function optionalStringish(value: Record<string, unknown>, key: string): string | undefined;
export declare function normalizeAuthor(value: unknown): "assistant" | "system" | "user" | undefined;
export declare function requireNativeInboundId(value: string, rule: NativeIdRule, label: string): string;
export declare function genericMockPayloadWithNativeThread(params: {
    channelRule?: NativeIdRule | undefined;
    payload: Record<string, unknown>;
    threadRule: NativeIdRule;
}): {
    author?: "assistant" | "system" | "user" | undefined;
    authorIsBot?: boolean;
    id?: string | undefined;
    raw: {};
    text?: string | undefined;
} | {
    author?: "assistant" | "system" | "user" | undefined;
    authorIsBot?: boolean;
    id?: string | undefined;
    message?: {
        author?: "assistant" | "system" | "user" | undefined;
        authorIsBot?: boolean;
        id?: string | undefined;
        raw?: {} | null;
        text?: string | undefined;
        threadId: string;
    };
    raw: {};
    text?: string | undefined;
    threadId: string;
};
export declare function authorFromBotFlag(isBot: boolean | undefined): InboundEnvelope["author"];
