import { type IncomingMessage } from "node:http";
import { type ServerEventObserver } from "./recorder.js";
type TelegramWebhook = {
    lastErrorDate?: number;
    lastErrorMessage?: string;
    secretToken?: string;
    url: string;
};
type TelegramServerState = {
    activeUpdatePoll: TelegramUpdatePoll | undefined;
    activeWebhookDeliveries: Set<AbortController>;
    activeWebhookValidations: Set<AbortController>;
    adminToken: string;
    allowLoopbackHttpWebhook: boolean;
    botId: number;
    botToken: string;
    botUsername: string;
    closing: boolean;
    inboundAdmission: Promise<void>;
    maxPendingInboundEvents: number;
    nextMessageId: number;
    nextUpdateId: number;
    onEvent: ServerEventObserver | undefined;
    recorderPath: string;
    restrictWebhookTargets: boolean;
    updates: TelegramUpdate[];
    webhook: TelegramWebhook | undefined;
    webhookAdmission: Promise<void>;
    webhookDelivery: Promise<Response | undefined> | undefined;
    webhookRetryAttempts: number;
    webhookRetryTimer: NodeJS.Timeout | undefined;
    webhookRetryUpdateId: number | undefined;
};
type TelegramUpdatePoll = {
    finish(result: TelegramUpdatePollResult): void;
};
type TelegramUpdatePollResult = "conflict" | "shutdown" | "timeout" | "update";
type TelegramGetUpdatesState = Pick<TelegramServerState, "activeUpdatePoll" | "closing" | "updates">;
type TelegramMessage = {
    chat: {
        id: number | string;
        title?: string;
        type: "group" | "private" | "supergroup";
    };
    animation?: {
        duration: number;
        file_id: string;
        file_name?: string;
        file_unique_id: string;
        height: number;
        mime_type?: string;
        width: number;
    };
    caption?: string;
    date: number;
    document?: {
        file_id: string;
        file_name?: string;
        file_unique_id: string;
        mime_type?: string;
    };
    audio?: {
        duration: number;
        file_id: string;
        file_name?: string;
        file_unique_id: string;
        mime_type?: string;
    };
    entities?: Array<{
        length: number;
        offset: number;
        type: string;
    }>;
    from: {
        first_name: string;
        id: number;
        is_bot: boolean;
        username?: string;
    };
    message_id: number;
    message_thread_id?: number;
    photo?: Array<{
        file_id: string;
        file_unique_id: string;
        height: number;
        width: number;
    }>;
    text?: string;
    video?: {
        duration: number;
        file_id: string;
        file_name?: string;
        file_unique_id: string;
        height: number;
        mime_type?: string;
        width: number;
    };
};
type TelegramUpdate = {
    message: TelegramMessage;
    update_id: number;
};
export type TelegramServerManifest = {
    adminToken: string;
    baseUrl: string;
    botToken: string;
    endpoints: {
        adminInboundUrl: string;
        apiRoot: string;
    };
    env: {
        TELEGRAM_BOT_TOKEN: string;
    };
    provider: "telegram";
    recorderPath: string;
    version: 1;
};
export type StartedTelegramServer = {
    close(): Promise<void>;
    manifest: TelegramServerManifest;
};
export type StartTelegramServerParams = {
    adminToken?: string | undefined;
    botId?: number | undefined;
    botToken?: string | undefined;
    botUsername?: string | undefined;
    host?: string | undefined;
    onEvent?: ServerEventObserver | undefined;
    port?: number | undefined;
    recorderPath?: string | undefined;
    maxPendingInboundEvents?: number | undefined;
};
/** @internal */
export declare function withTelegramWebhookDeadline<T>(promise: Promise<T>, deadlineAt: number, signal: AbortSignal): Promise<T>;
/** @internal */
export declare function handleTelegramGetUpdates(params: {
    body: Record<string, unknown>;
    request: IncomingMessage;
    state: TelegramGetUpdatesState;
}): Promise<Response>;
export declare function startTelegramServer(params?: StartTelegramServerParams): Promise<StartedTelegramServer>;
export {};
