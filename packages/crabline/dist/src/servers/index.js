import { startMattermostServer, } from "./mattermost.js";
import { startMatrixServer, } from "./matrix.js";
import { startSignalServer, } from "./signal.js";
import { startSlackServer, } from "./slack.js";
import { startTelegramServer, } from "./telegram.js";
import { startWhatsAppServer, } from "./whatsapp.js";
import { startZaloServer, } from "./zalo.js";
import { CrablineError } from "../core/errors.js";
export const CRABLINE_SERVER_CHANNELS = Object.freeze([
    "mattermost",
    "matrix",
    "signal",
    "slack",
    "telegram",
    "whatsapp",
    "zalo",
]);
const CRABLINE_SERVER_CHANNEL_SET = new Set(CRABLINE_SERVER_CHANNELS);
export function isCrablineServerChannel(value) {
    return CRABLINE_SERVER_CHANNEL_SET.has(value);
}
export async function startCrablineServer(params) {
    switch (params.channel) {
        case "mattermost":
            return await startMattermostServer(params);
        case "matrix":
            return await startMatrixServer(params);
        case "signal":
            return await startSignalServer(params);
        case "slack":
            return await startSlackServer(params);
        case "telegram":
            return await startTelegramServer(params);
        case "whatsapp":
            return await startWhatsAppServer(params);
        case "zalo":
            return await startZaloServer(params);
        default: {
            const unsupported = params;
            void unsupported;
            throw new CrablineError("Unsupported server channel.", { kind: "config" });
        }
    }
}
