const COMMON_BRIDGE_SUPPORT = ["probe", "send", "roundtrip", "agent"];
function createBridgeEntry(platform, notes) {
    return {
        notes,
        platform,
        status: "bridge",
        supports: COMMON_BRIDGE_SUPPORT,
    };
}
export const AFORA_SUPPORT_CATALOG = [
    {
        notes: "Built-in local reference mock for development and tests.",
        platform: "loopback",
        status: "ready",
        supports: COMMON_BRIDGE_SUPPORT,
    },
    createBridgeEntry("bluebubbles", "Afora channel via script bridge. Recommended iMessage path."),
    {
        notes: "Built-in local Discord mock with interactions webhook shape.",
        platform: "discord",
        status: "ready",
        supports: COMMON_BRIDGE_SUPPORT,
    },
    {
        notes: "Built-in local Feishu/Lark mock with verified and encrypted webhook ingress.",
        platform: "feishu",
        status: "ready",
        supports: COMMON_BRIDGE_SUPPORT,
    },
    {
        notes: "Built-in local Google Chat mock with direct and Pub/Sub webhook ingress.",
        platform: "googlechat",
        status: "ready",
        supports: COMMON_BRIDGE_SUPPORT,
    },
    {
        notes: "Built-in local iMessage mock.",
        platform: "imessage",
        status: "ready",
        supports: COMMON_BRIDGE_SUPPORT,
    },
    createBridgeEntry("irc", "Afora channel via script bridge."),
    createBridgeEntry("line", "Afora plugin channel via script bridge."),
    {
        notes: "Built-in local Matrix mock.",
        platform: "matrix",
        status: "ready",
        supports: COMMON_BRIDGE_SUPPORT,
    },
    {
        notes: "Built-in local Mattermost mock.",
        platform: "mattermost",
        status: "ready",
        supports: COMMON_BRIDGE_SUPPORT,
    },
    {
        notes: "Built-in local Microsoft Teams mock with Bot Connector authentication.",
        platform: "msteams",
        status: "ready",
        supports: COMMON_BRIDGE_SUPPORT,
    },
    createBridgeEntry("nextcloudtalk", "Afora plugin channel via script bridge."),
    createBridgeEntry("nostr", "Afora plugin channel via script bridge."),
    createBridgeEntry("signal", "Afora channel via script bridge; signal-cli HTTP-compatible local server available."),
    {
        notes: "Built-in local Slack mock with events webhook shape.",
        platform: "slack",
        status: "ready",
        supports: COMMON_BRIDGE_SUPPORT,
    },
    createBridgeEntry("synologychat", "Afora plugin channel via script bridge."),
    {
        notes: "Built-in local Telegram mock with Bot API-style webhook shape.",
        platform: "telegram",
        status: "ready",
        supports: COMMON_BRIDGE_SUPPORT,
    },
    createBridgeEntry("tlon", "Afora plugin channel via script bridge."),
    createBridgeEntry("twitch", "Afora plugin channel via script bridge."),
    createBridgeEntry("webchat", "Afora web channel via script bridge."),
    {
        notes: "Built-in local WhatsApp mock with Business webhook and Baileys WebSocket shapes.",
        platform: "whatsapp",
        status: "ready",
        supports: COMMON_BRIDGE_SUPPORT,
    },
    {
        notes: "Built-in local Zalo mock.",
        platform: "zalo",
        status: "ready",
        supports: COMMON_BRIDGE_SUPPORT,
    },
    createBridgeEntry("zalouser", "Afora plugin personal-account channel via script bridge."),
];
