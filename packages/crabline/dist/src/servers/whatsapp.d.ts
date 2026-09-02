import { type ServerEventObserver } from "./recorder.js";
import { type WhatsAppBaileysInboundMessage } from "./whatsapp-baileys-websocket.js";
export type WhatsAppBaileysMessage = WhatsAppBaileysInboundMessage;
export type WhatsAppServerManifest = {
    accessToken: string;
    adminToken: string;
    baseUrl: string;
    endpoints: {
        adminInboundUrl: string;
        apiRoot: string;
        baileysWebSocketUrl: string;
        messagesUrl: string;
        phoneNumberUrl: string;
        statusUrl: string;
    };
    env: {
        CLOUD_API_ACCESS_TOKEN: string;
        CLOUD_API_VERSION: string;
        WA_BASE_URL: string;
        WA_PHONE_NUMBER_ID: string;
    };
    graphVersion: string;
    phoneNumberId: string;
    provider: "whatsapp";
    recorderPath: string;
    selfJid: string;
    version: 1;
};
export type StartedWhatsAppServer = {
    close(): Promise<void>;
    manifest: WhatsAppServerManifest;
};
export type StartWhatsAppServerParams = {
    accessToken?: string | undefined;
    adminToken?: string | undefined;
    displayPhoneNumber?: string | undefined;
    graphVersion?: string | undefined;
    host?: string | undefined;
    maxPendingInboundMessages?: number | undefined;
    onEvent?: ServerEventObserver | undefined;
    phoneNumberId?: string | undefined;
    port?: number | undefined;
    recorderPath?: string | undefined;
    selfJid?: string | undefined;
};
export declare function startWhatsAppServer(params?: StartWhatsAppServerParams): Promise<StartedWhatsAppServer>;
