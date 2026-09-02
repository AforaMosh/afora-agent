import type { FixtureMode, ProviderPlatform } from "../config/schema.js";
import type { ProviderSupportStatus } from "./types.js";
export type CatalogEntry = {
    notes: string;
    platform: ProviderPlatform;
    status: ProviderSupportStatus;
    supports: readonly FixtureMode[];
};
export declare const AFORA_SUPPORT_CATALOG: readonly [{
    readonly notes: "Built-in local reference mock for development and tests.";
    readonly platform: "loopback";
    readonly status: "ready";
    readonly supports: readonly ["probe", "send", "roundtrip", "agent"];
}, CatalogEntry, {
    readonly notes: "Built-in local Discord mock with interactions webhook shape.";
    readonly platform: "discord";
    readonly status: "ready";
    readonly supports: readonly ["probe", "send", "roundtrip", "agent"];
}, {
    readonly notes: "Built-in local Feishu/Lark mock with verified and encrypted webhook ingress.";
    readonly platform: "feishu";
    readonly status: "ready";
    readonly supports: readonly ["probe", "send", "roundtrip", "agent"];
}, {
    readonly notes: "Built-in local Google Chat mock with direct and Pub/Sub webhook ingress.";
    readonly platform: "googlechat";
    readonly status: "ready";
    readonly supports: readonly ["probe", "send", "roundtrip", "agent"];
}, {
    readonly notes: "Built-in local iMessage mock.";
    readonly platform: "imessage";
    readonly status: "ready";
    readonly supports: readonly ["probe", "send", "roundtrip", "agent"];
}, CatalogEntry, CatalogEntry, {
    readonly notes: "Built-in local Matrix mock.";
    readonly platform: "matrix";
    readonly status: "ready";
    readonly supports: readonly ["probe", "send", "roundtrip", "agent"];
}, {
    readonly notes: "Built-in local Mattermost mock.";
    readonly platform: "mattermost";
    readonly status: "ready";
    readonly supports: readonly ["probe", "send", "roundtrip", "agent"];
}, {
    readonly notes: "Built-in local Microsoft Teams mock with Bot Connector authentication.";
    readonly platform: "msteams";
    readonly status: "ready";
    readonly supports: readonly ["probe", "send", "roundtrip", "agent"];
}, CatalogEntry, CatalogEntry, CatalogEntry, {
    readonly notes: "Built-in local Slack mock with events webhook shape.";
    readonly platform: "slack";
    readonly status: "ready";
    readonly supports: readonly ["probe", "send", "roundtrip", "agent"];
}, CatalogEntry, {
    readonly notes: "Built-in local Telegram mock with Bot API-style webhook shape.";
    readonly platform: "telegram";
    readonly status: "ready";
    readonly supports: readonly ["probe", "send", "roundtrip", "agent"];
}, CatalogEntry, CatalogEntry, CatalogEntry, {
    readonly notes: "Built-in local WhatsApp mock with Business webhook and Baileys WebSocket shapes.";
    readonly platform: "whatsapp";
    readonly status: "ready";
    readonly supports: readonly ["probe", "send", "roundtrip", "agent"];
}, {
    readonly notes: "Built-in local Zalo mock.";
    readonly platform: "zalo";
    readonly status: "ready";
    readonly supports: readonly ["probe", "send", "roundtrip", "agent"];
}, CatalogEntry];
