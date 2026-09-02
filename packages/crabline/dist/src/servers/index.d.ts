import { type MattermostServerManifest, type StartedMattermostServer, type StartMattermostServerParams } from "./mattermost.js";
import { type MatrixServerManifest, type StartedMatrixServer, type StartMatrixServerParams } from "./matrix.js";
import { type SignalServerManifest, type StartedSignalServer, type StartSignalServerParams } from "./signal.js";
import { type SlackServerManifest, type StartedSlackServer, type StartSlackServerParams } from "./slack.js";
import { type StartedTelegramServer, type StartTelegramServerParams, type TelegramServerManifest } from "./telegram.js";
import { type StartedWhatsAppServer, type StartWhatsAppServerParams, type WhatsAppServerManifest } from "./whatsapp.js";
import { type StartedZaloServer, type StartZaloServerParams, type ZaloServerManifest } from "./zalo.js";
export declare const CRABLINE_SERVER_CHANNELS: readonly ["mattermost", "matrix", "signal", "slack", "telegram", "whatsapp", "zalo"];
export type CrablineServerChannel = (typeof CRABLINE_SERVER_CHANNELS)[number];
export type CrablineServerManifest = MattermostServerManifest | MatrixServerManifest | SignalServerManifest | SlackServerManifest | TelegramServerManifest | WhatsAppServerManifest | ZaloServerManifest;
export type StartedCrablineServer = StartedMattermostServer | StartedMatrixServer | StartedSignalServer | StartedSlackServer | StartedTelegramServer | StartedWhatsAppServer | StartedZaloServer;
export type StartCrablineServerParams = (StartMattermostServerParams & {
    channel: "mattermost";
}) | (StartMatrixServerParams & {
    channel: "matrix";
}) | (StartSignalServerParams & {
    channel: "signal";
}) | (StartSlackServerParams & {
    channel: "slack";
}) | (StartTelegramServerParams & {
    channel: "telegram";
}) | (StartWhatsAppServerParams & {
    channel: "whatsapp";
}) | (StartZaloServerParams & {
    channel: "zalo";
});
export declare function isCrablineServerChannel(value: string): value is CrablineServerChannel;
export declare function startCrablineServer(params: StartMattermostServerParams & {
    channel: "mattermost";
}): Promise<StartedMattermostServer>;
export declare function startCrablineServer(params: StartMatrixServerParams & {
    channel: "matrix";
}): Promise<StartedMatrixServer>;
export declare function startCrablineServer(params: StartSignalServerParams & {
    channel: "signal";
}): Promise<StartedSignalServer>;
export declare function startCrablineServer(params: StartSlackServerParams & {
    channel: "slack";
}): Promise<StartedSlackServer>;
export declare function startCrablineServer(params: StartTelegramServerParams & {
    channel: "telegram";
}): Promise<StartedTelegramServer>;
export declare function startCrablineServer(params: StartWhatsAppServerParams & {
    channel: "whatsapp";
}): Promise<StartedWhatsAppServer>;
export declare function startCrablineServer(params: StartZaloServerParams & {
    channel: "zalo";
}): Promise<StartedZaloServer>;
export declare function startCrablineServer(params: StartCrablineServerParams): Promise<StartedCrablineServer>;
