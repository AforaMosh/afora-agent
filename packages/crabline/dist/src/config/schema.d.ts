import { z } from "zod";
export declare const FIXTURE_MODES: readonly ["probe", "send", "roundtrip", "agent"];
export declare const INBOUND_AUTHORS: readonly ["assistant", "user", "system", "any"];
export declare const INBOUND_STRATEGIES: readonly ["contains", "exact", "regex"];
export declare const INBOUND_NONCE_MODES: readonly ["contains", "exact", "ignore"];
export declare const BUILTIN_ADAPTERS: readonly ["discord", "feishu", "googlechat", "imessage", "loopback", "matrix", "mattermost", "msteams", "script", "slack", "telegram", "whatsapp", "zalo"];
export declare const PROVIDER_PLATFORMS: readonly ["bluebubbles", "discord", "feishu", "googlechat", "imessage", "irc", "line", "loopback", "matrix", "mattermost", "msteams", "nextcloudtalk", "nostr", "signal", "slack", "synologychat", "telegram", "tlon", "twitch", "webchat", "whatsapp", "zalo", "zalouser"];
type BuiltinAdapterName = (typeof BUILTIN_ADAPTERS)[number];
type ProviderPlatformName = (typeof PROVIDER_PLATFORMS)[number];
export declare const ProviderConfigSchema: z.ZodPipe<z.ZodObject<{
    adapter: z.ZodEnum<{
        discord: "discord";
        feishu: "feishu";
        googlechat: "googlechat";
        imessage: "imessage";
        loopback: "loopback";
        matrix: "matrix";
        mattermost: "mattermost";
        msteams: "msteams";
        script: "script";
        slack: "slack";
        telegram: "telegram";
        whatsapp: "whatsapp";
        zalo: "zalo";
    }>;
    capabilities: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        agent: "agent";
        probe: "probe";
        roundtrip: "roundtrip";
        send: "send";
    }>>>;
    discord: z.ZodOptional<z.ZodObject<{
        applicationId: z.ZodOptional<z.ZodString>;
        botToken: z.ZodOptional<z.ZodString>;
        gatewayDurationMs: z.ZodDefault<z.ZodNumber>;
        mentionRoleIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        publicKey: z.ZodOptional<z.ZodString>;
        recorder: z.ZodDefault<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        webhook: z.ZodDefault<z.ZodObject<{
            host: z.ZodDefault<z.ZodString>;
            path: z.ZodDefault<z.ZodString>;
            port: z.ZodDefault<z.ZodNumber>;
            publicUrl: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    env: z.ZodDefault<z.ZodArray<z.ZodString>>;
    feishu: z.ZodOptional<z.ZodObject<{
        appId: z.ZodOptional<z.ZodString>;
        appSecret: z.ZodOptional<z.ZodString>;
        encryptKey: z.ZodOptional<z.ZodString>;
        recorder: z.ZodDefault<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        userName: z.ZodOptional<z.ZodString>;
        verificationToken: z.ZodOptional<z.ZodString>;
        webhook: z.ZodDefault<z.ZodObject<{
            host: z.ZodDefault<z.ZodString>;
            path: z.ZodDefault<z.ZodString>;
            port: z.ZodDefault<z.ZodNumber>;
            publicUrl: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    googlechat: z.ZodOptional<z.ZodObject<{
        apiUrl: z.ZodOptional<z.ZodString>;
        credentials: z.ZodOptional<z.ZodObject<{
            client_email: z.ZodString;
            private_key: z.ZodString;
            project_id: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
        disableSignatureVerification: z.ZodOptional<z.ZodBoolean>;
        endpointUrl: z.ZodOptional<z.ZodString>;
        googleChatProjectNumber: z.ZodOptional<z.ZodString>;
        impersonateUser: z.ZodOptional<z.ZodString>;
        pubsubAudience: z.ZodOptional<z.ZodString>;
        pubsubServiceAccountEmail: z.ZodOptional<z.ZodString>;
        pubsubTopic: z.ZodOptional<z.ZodString>;
        recorder: z.ZodDefault<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        useApplicationDefaultCredentials: z.ZodOptional<z.ZodBoolean>;
        userName: z.ZodOptional<z.ZodString>;
        webhook: z.ZodDefault<z.ZodObject<{
            host: z.ZodDefault<z.ZodString>;
            path: z.ZodDefault<z.ZodString>;
            port: z.ZodDefault<z.ZodNumber>;
            publicUrl: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    imessage: z.ZodOptional<z.ZodObject<{
        apiKey: z.ZodOptional<z.ZodString>;
        gatewayDurationMs: z.ZodDefault<z.ZodNumber>;
        local: z.ZodOptional<z.ZodBoolean>;
        recorder: z.ZodDefault<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        serverUrl: z.ZodOptional<z.ZodString>;
        webhook: z.ZodDefault<z.ZodObject<{
            host: z.ZodDefault<z.ZodString>;
            path: z.ZodDefault<z.ZodString>;
            port: z.ZodDefault<z.ZodNumber>;
            publicUrl: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    loopback: z.ZodOptional<z.ZodObject<{
        delayMs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    matrix: z.ZodOptional<z.ZodObject<{
        auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
            accessToken: z.ZodString;
            type: z.ZodLiteral<"accessToken">;
            userID: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            password: z.ZodString;
            type: z.ZodLiteral<"password">;
            userID: z.ZodOptional<z.ZodString>;
            username: z.ZodString;
        }, z.core.$strict>]>>;
        baseURL: z.ZodOptional<z.ZodString>;
        commandPrefix: z.ZodOptional<z.ZodString>;
        recorder: z.ZodDefault<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        recoveryKey: z.ZodOptional<z.ZodString>;
        roomAllowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
        webhook: z.ZodDefault<z.ZodObject<{
            host: z.ZodDefault<z.ZodString>;
            path: z.ZodDefault<z.ZodString>;
            port: z.ZodDefault<z.ZodNumber>;
            publicUrl: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    mattermost: z.ZodOptional<z.ZodObject<{
        baseUrl: z.ZodOptional<z.ZodString>;
        botToken: z.ZodOptional<z.ZodString>;
        callbackUrl: z.ZodOptional<z.ZodString>;
        recorder: z.ZodDefault<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        userName: z.ZodOptional<z.ZodString>;
        webhook: z.ZodDefault<z.ZodObject<{
            host: z.ZodDefault<z.ZodString>;
            path: z.ZodDefault<z.ZodString>;
            port: z.ZodDefault<z.ZodNumber>;
            publicUrl: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        websocket: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            maxReconnectDelayMs: z.ZodOptional<z.ZodNumber>;
            reconnectDelayMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    msteams: z.ZodOptional<z.ZodObject<{
        apiUrl: z.ZodOptional<z.ZodString>;
        appId: z.ZodOptional<z.ZodString>;
        appPassword: z.ZodOptional<z.ZodString>;
        appTenantId: z.ZodOptional<z.ZodString>;
        appType: z.ZodOptional<z.ZodEnum<{
            MultiTenant: "MultiTenant";
            SingleTenant: "SingleTenant";
        }>>;
        dialogOpenTimeoutMs: z.ZodOptional<z.ZodNumber>;
        federated: z.ZodOptional<z.ZodObject<{
            clientAudience: z.ZodOptional<z.ZodString>;
            clientId: z.ZodString;
        }, z.core.$strict>>;
        recorder: z.ZodDefault<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        userName: z.ZodOptional<z.ZodString>;
        webhook: z.ZodDefault<z.ZodObject<{
            host: z.ZodDefault<z.ZodString>;
            path: z.ZodDefault<z.ZodString>;
            port: z.ZodDefault<z.ZodNumber>;
            publicUrl: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    notes: z.ZodOptional<z.ZodString>;
    platform: z.ZodOptional<z.ZodEnum<{
        bluebubbles: "bluebubbles";
        discord: "discord";
        feishu: "feishu";
        googlechat: "googlechat";
        imessage: "imessage";
        irc: "irc";
        line: "line";
        loopback: "loopback";
        matrix: "matrix";
        mattermost: "mattermost";
        msteams: "msteams";
        nextcloudtalk: "nextcloudtalk";
        nostr: "nostr";
        signal: "signal";
        slack: "slack";
        synologychat: "synologychat";
        telegram: "telegram";
        tlon: "tlon";
        twitch: "twitch";
        webchat: "webchat";
        whatsapp: "whatsapp";
        zalo: "zalo";
        zalouser: "zalouser";
    }>>;
    slack: z.ZodOptional<z.ZodObject<{
        recorder: z.ZodDefault<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        signingSecret: z.ZodOptional<z.ZodString>;
        webhook: z.ZodDefault<z.ZodObject<{
            host: z.ZodDefault<z.ZodString>;
            path: z.ZodDefault<z.ZodString>;
            port: z.ZodDefault<z.ZodNumber>;
            publicUrl: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    script: z.ZodOptional<z.ZodObject<{
        commands: z.ZodObject<{
            probe: z.ZodOptional<z.ZodString>;
            send: z.ZodOptional<z.ZodString>;
            waitForInbound: z.ZodOptional<z.ZodString>;
            watch: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        cwd: z.ZodOptional<z.ZodString>;
        shell: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    status: z.ZodDefault<z.ZodEnum<{
        active: "active";
        disabled: "disabled";
        planned: "planned";
    }>>;
    telegram: z.ZodOptional<z.ZodObject<{
        apiUrl: z.ZodOptional<z.ZodString>;
        botToken: z.ZodOptional<z.ZodString>;
        longPolling: z.ZodOptional<z.ZodObject<{
            allowedUpdates: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deleteWebhook: z.ZodOptional<z.ZodBoolean>;
            dropPendingUpdates: z.ZodOptional<z.ZodBoolean>;
            limit: z.ZodOptional<z.ZodNumber>;
            retryDelayMs: z.ZodOptional<z.ZodNumber>;
            timeout: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        mode: z.ZodDefault<z.ZodEnum<{
            auto: "auto";
            polling: "polling";
            webhook: "webhook";
        }>>;
        recorder: z.ZodDefault<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        secretToken: z.ZodOptional<z.ZodString>;
        userName: z.ZodOptional<z.ZodString>;
        webhook: z.ZodDefault<z.ZodObject<{
            host: z.ZodDefault<z.ZodString>;
            path: z.ZodDefault<z.ZodString>;
            port: z.ZodDefault<z.ZodNumber>;
            publicUrl: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    whatsapp: z.ZodOptional<z.ZodObject<{
        accessToken: z.ZodOptional<z.ZodString>;
        apiUrl: z.ZodOptional<z.ZodString>;
        apiVersion: z.ZodOptional<z.ZodString>;
        appSecret: z.ZodOptional<z.ZodString>;
        phoneNumberId: z.ZodOptional<z.ZodString>;
        recorder: z.ZodDefault<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        userName: z.ZodOptional<z.ZodString>;
        verifyToken: z.ZodOptional<z.ZodString>;
        webhook: z.ZodDefault<z.ZodObject<{
            host: z.ZodDefault<z.ZodString>;
            path: z.ZodDefault<z.ZodString>;
            port: z.ZodDefault<z.ZodNumber>;
            publicUrl: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    zalo: z.ZodOptional<z.ZodObject<{
        botToken: z.ZodOptional<z.ZodString>;
        recorder: z.ZodDefault<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        userName: z.ZodOptional<z.ZodString>;
        webhook: z.ZodDefault<z.ZodObject<{
            host: z.ZodDefault<z.ZodString>;
            path: z.ZodDefault<z.ZodString>;
            port: z.ZodDefault<z.ZodNumber>;
            publicUrl: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        webhookSecret: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodTransform<{
    adapter: "discord" | "feishu" | "googlechat" | "imessage" | "loopback" | "matrix" | "mattermost" | "msteams" | "script" | "slack" | "telegram" | "whatsapp" | "zalo";
    capabilities: ("agent" | "probe" | "roundtrip" | "send")[];
    discord?: {
        applicationId?: string | undefined;
        botToken?: string | undefined;
        gatewayDurationMs: number;
        mentionRoleIds?: string[] | undefined;
        publicKey?: string | undefined;
        recorder: {
            path?: string | undefined;
        };
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    env: string[];
    feishu?: {
        appId?: string | undefined;
        appSecret?: string | undefined;
        encryptKey?: string | undefined;
        recorder: {
            path?: string | undefined;
        };
        userName?: string | undefined;
        verificationToken?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    googlechat?: {
        apiUrl?: string | undefined;
        credentials?: {
            [x: string]: unknown;
            client_email: string;
            private_key: string;
            project_id?: string | undefined;
        } | undefined;
        disableSignatureVerification?: boolean | undefined;
        endpointUrl?: string | undefined;
        googleChatProjectNumber?: string | undefined;
        impersonateUser?: string | undefined;
        pubsubAudience?: string | undefined;
        pubsubServiceAccountEmail?: string | undefined;
        pubsubTopic?: string | undefined;
        recorder: {
            path?: string | undefined;
        };
        useApplicationDefaultCredentials?: boolean | undefined;
        userName?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    imessage?: {
        apiKey?: string | undefined;
        gatewayDurationMs: number;
        local?: boolean | undefined;
        recorder: {
            path?: string | undefined;
        };
        serverUrl?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    loopback?: {
        delayMs: number;
    } | undefined;
    matrix?: {
        auth?: {
            accessToken: string;
            type: "accessToken";
            userID?: string | undefined;
        } | {
            password: string;
            type: "password";
            userID?: string | undefined;
            username: string;
        } | undefined;
        baseURL?: string | undefined;
        commandPrefix?: string | undefined;
        recorder: {
            path?: string | undefined;
        };
        recoveryKey?: string | undefined;
        roomAllowlist?: string[] | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    mattermost?: {
        baseUrl?: string | undefined;
        botToken?: string | undefined;
        callbackUrl?: string | undefined;
        recorder: {
            path?: string | undefined;
        };
        userName?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
        websocket?: {
            enabled?: boolean | undefined;
            maxReconnectDelayMs?: number | undefined;
            reconnectDelayMs?: number | undefined;
        } | undefined;
    } | undefined;
    msteams?: {
        apiUrl?: string | undefined;
        appId?: string | undefined;
        appPassword?: string | undefined;
        appTenantId?: string | undefined;
        appType?: "MultiTenant" | "SingleTenant" | undefined;
        dialogOpenTimeoutMs?: number | undefined;
        federated?: {
            clientAudience?: string | undefined;
            clientId: string;
        } | undefined;
        recorder: {
            path?: string | undefined;
        };
        userName?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    notes?: string | undefined;
    slack?: {
        recorder: {
            path?: string | undefined;
        };
        signingSecret?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    script?: {
        commands: {
            probe?: string | undefined;
            send?: string | undefined;
            waitForInbound?: string | undefined;
            watch?: string | undefined;
        };
        cwd?: string | undefined;
        shell?: string | undefined;
    } | undefined;
    status: "active" | "disabled" | "planned";
    telegram?: {
        apiUrl?: string | undefined;
        botToken?: string | undefined;
        longPolling?: {
            allowedUpdates?: string[] | undefined;
            deleteWebhook?: boolean | undefined;
            dropPendingUpdates?: boolean | undefined;
            limit?: number | undefined;
            retryDelayMs?: number | undefined;
            timeout?: number | undefined;
        } | undefined;
        mode: "auto" | "polling" | "webhook";
        recorder: {
            path?: string | undefined;
        };
        secretToken?: string | undefined;
        userName?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    whatsapp?: {
        accessToken?: string | undefined;
        apiUrl?: string | undefined;
        apiVersion?: string | undefined;
        appSecret?: string | undefined;
        phoneNumberId?: string | undefined;
        recorder: {
            path?: string | undefined;
        };
        userName?: string | undefined;
        verifyToken?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    zalo?: {
        botToken?: string | undefined;
        recorder: {
            path?: string | undefined;
        };
        userName?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
        webhookSecret?: string | undefined;
    } | undefined;
    platform: "bluebubbles" | "discord" | "feishu" | "googlechat" | "imessage" | "irc" | "line" | "loopback" | "matrix" | "mattermost" | "msteams" | "nextcloudtalk" | "nostr" | "signal" | "slack" | "synologychat" | "telegram" | "tlon" | "twitch" | "webchat" | "whatsapp" | "zalo" | "zalouser";
}, {
    adapter: "discord" | "feishu" | "googlechat" | "imessage" | "loopback" | "matrix" | "mattermost" | "msteams" | "script" | "slack" | "telegram" | "whatsapp" | "zalo";
    capabilities: ("agent" | "probe" | "roundtrip" | "send")[];
    discord?: {
        applicationId?: string | undefined;
        botToken?: string | undefined;
        gatewayDurationMs: number;
        mentionRoleIds?: string[] | undefined;
        publicKey?: string | undefined;
        recorder: {
            path?: string | undefined;
        };
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    env: string[];
    feishu?: {
        appId?: string | undefined;
        appSecret?: string | undefined;
        encryptKey?: string | undefined;
        recorder: {
            path?: string | undefined;
        };
        userName?: string | undefined;
        verificationToken?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    googlechat?: {
        apiUrl?: string | undefined;
        credentials?: {
            [x: string]: unknown;
            client_email: string;
            private_key: string;
            project_id?: string | undefined;
        } | undefined;
        disableSignatureVerification?: boolean | undefined;
        endpointUrl?: string | undefined;
        googleChatProjectNumber?: string | undefined;
        impersonateUser?: string | undefined;
        pubsubAudience?: string | undefined;
        pubsubServiceAccountEmail?: string | undefined;
        pubsubTopic?: string | undefined;
        recorder: {
            path?: string | undefined;
        };
        useApplicationDefaultCredentials?: boolean | undefined;
        userName?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    imessage?: {
        apiKey?: string | undefined;
        gatewayDurationMs: number;
        local?: boolean | undefined;
        recorder: {
            path?: string | undefined;
        };
        serverUrl?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    loopback?: {
        delayMs: number;
    } | undefined;
    matrix?: {
        auth?: {
            accessToken: string;
            type: "accessToken";
            userID?: string | undefined;
        } | {
            password: string;
            type: "password";
            userID?: string | undefined;
            username: string;
        } | undefined;
        baseURL?: string | undefined;
        commandPrefix?: string | undefined;
        recorder: {
            path?: string | undefined;
        };
        recoveryKey?: string | undefined;
        roomAllowlist?: string[] | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    mattermost?: {
        baseUrl?: string | undefined;
        botToken?: string | undefined;
        callbackUrl?: string | undefined;
        recorder: {
            path?: string | undefined;
        };
        userName?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
        websocket?: {
            enabled?: boolean | undefined;
            maxReconnectDelayMs?: number | undefined;
            reconnectDelayMs?: number | undefined;
        } | undefined;
    } | undefined;
    msteams?: {
        apiUrl?: string | undefined;
        appId?: string | undefined;
        appPassword?: string | undefined;
        appTenantId?: string | undefined;
        appType?: "MultiTenant" | "SingleTenant" | undefined;
        dialogOpenTimeoutMs?: number | undefined;
        federated?: {
            clientAudience?: string | undefined;
            clientId: string;
        } | undefined;
        recorder: {
            path?: string | undefined;
        };
        userName?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    notes?: string | undefined;
    platform?: "bluebubbles" | "discord" | "feishu" | "googlechat" | "imessage" | "irc" | "line" | "loopback" | "matrix" | "mattermost" | "msteams" | "nextcloudtalk" | "nostr" | "signal" | "slack" | "synologychat" | "telegram" | "tlon" | "twitch" | "webchat" | "whatsapp" | "zalo" | "zalouser" | undefined;
    slack?: {
        recorder: {
            path?: string | undefined;
        };
        signingSecret?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    script?: {
        commands: {
            probe?: string | undefined;
            send?: string | undefined;
            waitForInbound?: string | undefined;
            watch?: string | undefined;
        };
        cwd?: string | undefined;
        shell?: string | undefined;
    } | undefined;
    status: "active" | "disabled" | "planned";
    telegram?: {
        apiUrl?: string | undefined;
        botToken?: string | undefined;
        longPolling?: {
            allowedUpdates?: string[] | undefined;
            deleteWebhook?: boolean | undefined;
            dropPendingUpdates?: boolean | undefined;
            limit?: number | undefined;
            retryDelayMs?: number | undefined;
            timeout?: number | undefined;
        } | undefined;
        mode: "auto" | "polling" | "webhook";
        recorder: {
            path?: string | undefined;
        };
        secretToken?: string | undefined;
        userName?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    whatsapp?: {
        accessToken?: string | undefined;
        apiUrl?: string | undefined;
        apiVersion?: string | undefined;
        appSecret?: string | undefined;
        phoneNumberId?: string | undefined;
        recorder: {
            path?: string | undefined;
        };
        userName?: string | undefined;
        verifyToken?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
    } | undefined;
    zalo?: {
        botToken?: string | undefined;
        recorder: {
            path?: string | undefined;
        };
        userName?: string | undefined;
        webhook: {
            host: string;
            path: string;
            port: number;
            publicUrl?: string | undefined;
        };
        webhookSecret?: string | undefined;
    } | undefined;
}>>;
export declare const FixtureSchema: z.ZodObject<{
    accountId: z.ZodOptional<z.ZodString>;
    env: z.ZodDefault<z.ZodArray<z.ZodString>>;
    id: z.ZodString;
    inboundMatch: z.ZodDefault<z.ZodObject<{
        author: z.ZodDefault<z.ZodEnum<{
            any: "any";
            assistant: "assistant";
            system: "system";
            user: "user";
        }>>;
        nonce: z.ZodDefault<z.ZodEnum<{
            contains: "contains";
            exact: "exact";
            ignore: "ignore";
        }>>;
        pattern: z.ZodOptional<z.ZodString>;
        strategy: z.ZodDefault<z.ZodEnum<{
            contains: "contains";
            exact: "exact";
            regex: "regex";
        }>>;
    }, z.core.$strict>>;
    mode: z.ZodEnum<{
        agent: "agent";
        probe: "probe";
        roundtrip: "roundtrip";
        send: "send";
    }>;
    notes: z.ZodOptional<z.ZodString>;
    provider: z.ZodString;
    retries: z.ZodDefault<z.ZodNumber>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    target: z.ZodObject<{
        id: z.ZodString;
        channelId: z.ZodOptional<z.ZodString>;
        threadId: z.ZodOptional<z.ZodString>;
        behavior: z.ZodOptional<z.ZodEnum<{
            agent: "agent";
            echo: "echo";
            sink: "sink";
        }>>;
        metadata: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strict>;
    timeoutMs: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export declare const ManifestSchema: z.ZodPreprocess<z.ZodObject<{
    configVersion: z.ZodDefault<z.ZodLiteral<1>>;
    fixtures: z.ZodDefault<z.ZodArray<z.ZodObject<{
        accountId: z.ZodOptional<z.ZodString>;
        env: z.ZodDefault<z.ZodArray<z.ZodString>>;
        id: z.ZodString;
        inboundMatch: z.ZodDefault<z.ZodObject<{
            author: z.ZodDefault<z.ZodEnum<{
                any: "any";
                assistant: "assistant";
                system: "system";
                user: "user";
            }>>;
            nonce: z.ZodDefault<z.ZodEnum<{
                contains: "contains";
                exact: "exact";
                ignore: "ignore";
            }>>;
            pattern: z.ZodOptional<z.ZodString>;
            strategy: z.ZodDefault<z.ZodEnum<{
                contains: "contains";
                exact: "exact";
                regex: "regex";
            }>>;
        }, z.core.$strict>>;
        mode: z.ZodEnum<{
            agent: "agent";
            probe: "probe";
            roundtrip: "roundtrip";
            send: "send";
        }>;
        notes: z.ZodOptional<z.ZodString>;
        provider: z.ZodString;
        retries: z.ZodDefault<z.ZodNumber>;
        tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
        target: z.ZodObject<{
            id: z.ZodString;
            channelId: z.ZodOptional<z.ZodString>;
            threadId: z.ZodOptional<z.ZodString>;
            behavior: z.ZodOptional<z.ZodEnum<{
                agent: "agent";
                echo: "echo";
                sink: "sink";
            }>>;
            metadata: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        }, z.core.$strict>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>>;
    providers: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodPipe<z.ZodObject<{
        adapter: z.ZodEnum<{
            discord: "discord";
            feishu: "feishu";
            googlechat: "googlechat";
            imessage: "imessage";
            loopback: "loopback";
            matrix: "matrix";
            mattermost: "mattermost";
            msteams: "msteams";
            script: "script";
            slack: "slack";
            telegram: "telegram";
            whatsapp: "whatsapp";
            zalo: "zalo";
        }>;
        capabilities: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            agent: "agent";
            probe: "probe";
            roundtrip: "roundtrip";
            send: "send";
        }>>>;
        discord: z.ZodOptional<z.ZodObject<{
            applicationId: z.ZodOptional<z.ZodString>;
            botToken: z.ZodOptional<z.ZodString>;
            gatewayDurationMs: z.ZodDefault<z.ZodNumber>;
            mentionRoleIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
            publicKey: z.ZodOptional<z.ZodString>;
            recorder: z.ZodDefault<z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            webhook: z.ZodDefault<z.ZodObject<{
                host: z.ZodDefault<z.ZodString>;
                path: z.ZodDefault<z.ZodString>;
                port: z.ZodDefault<z.ZodNumber>;
                publicUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        env: z.ZodDefault<z.ZodArray<z.ZodString>>;
        feishu: z.ZodOptional<z.ZodObject<{
            appId: z.ZodOptional<z.ZodString>;
            appSecret: z.ZodOptional<z.ZodString>;
            encryptKey: z.ZodOptional<z.ZodString>;
            recorder: z.ZodDefault<z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            userName: z.ZodOptional<z.ZodString>;
            verificationToken: z.ZodOptional<z.ZodString>;
            webhook: z.ZodDefault<z.ZodObject<{
                host: z.ZodDefault<z.ZodString>;
                path: z.ZodDefault<z.ZodString>;
                port: z.ZodDefault<z.ZodNumber>;
                publicUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        googlechat: z.ZodOptional<z.ZodObject<{
            apiUrl: z.ZodOptional<z.ZodString>;
            credentials: z.ZodOptional<z.ZodObject<{
                client_email: z.ZodString;
                private_key: z.ZodString;
                project_id: z.ZodOptional<z.ZodString>;
            }, z.core.$loose>>;
            disableSignatureVerification: z.ZodOptional<z.ZodBoolean>;
            endpointUrl: z.ZodOptional<z.ZodString>;
            googleChatProjectNumber: z.ZodOptional<z.ZodString>;
            impersonateUser: z.ZodOptional<z.ZodString>;
            pubsubAudience: z.ZodOptional<z.ZodString>;
            pubsubServiceAccountEmail: z.ZodOptional<z.ZodString>;
            pubsubTopic: z.ZodOptional<z.ZodString>;
            recorder: z.ZodDefault<z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            useApplicationDefaultCredentials: z.ZodOptional<z.ZodBoolean>;
            userName: z.ZodOptional<z.ZodString>;
            webhook: z.ZodDefault<z.ZodObject<{
                host: z.ZodDefault<z.ZodString>;
                path: z.ZodDefault<z.ZodString>;
                port: z.ZodDefault<z.ZodNumber>;
                publicUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        imessage: z.ZodOptional<z.ZodObject<{
            apiKey: z.ZodOptional<z.ZodString>;
            gatewayDurationMs: z.ZodDefault<z.ZodNumber>;
            local: z.ZodOptional<z.ZodBoolean>;
            recorder: z.ZodDefault<z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            serverUrl: z.ZodOptional<z.ZodString>;
            webhook: z.ZodDefault<z.ZodObject<{
                host: z.ZodDefault<z.ZodString>;
                path: z.ZodDefault<z.ZodString>;
                port: z.ZodDefault<z.ZodNumber>;
                publicUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        loopback: z.ZodOptional<z.ZodObject<{
            delayMs: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        matrix: z.ZodOptional<z.ZodObject<{
            auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                accessToken: z.ZodString;
                type: z.ZodLiteral<"accessToken">;
                userID: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>, z.ZodObject<{
                password: z.ZodString;
                type: z.ZodLiteral<"password">;
                userID: z.ZodOptional<z.ZodString>;
                username: z.ZodString;
            }, z.core.$strict>]>>;
            baseURL: z.ZodOptional<z.ZodString>;
            commandPrefix: z.ZodOptional<z.ZodString>;
            recorder: z.ZodDefault<z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            recoveryKey: z.ZodOptional<z.ZodString>;
            roomAllowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
            webhook: z.ZodDefault<z.ZodObject<{
                host: z.ZodDefault<z.ZodString>;
                path: z.ZodDefault<z.ZodString>;
                port: z.ZodDefault<z.ZodNumber>;
                publicUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        mattermost: z.ZodOptional<z.ZodObject<{
            baseUrl: z.ZodOptional<z.ZodString>;
            botToken: z.ZodOptional<z.ZodString>;
            callbackUrl: z.ZodOptional<z.ZodString>;
            recorder: z.ZodDefault<z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            userName: z.ZodOptional<z.ZodString>;
            webhook: z.ZodDefault<z.ZodObject<{
                host: z.ZodDefault<z.ZodString>;
                path: z.ZodDefault<z.ZodString>;
                port: z.ZodDefault<z.ZodNumber>;
                publicUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            websocket: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                maxReconnectDelayMs: z.ZodOptional<z.ZodNumber>;
                reconnectDelayMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        msteams: z.ZodOptional<z.ZodObject<{
            apiUrl: z.ZodOptional<z.ZodString>;
            appId: z.ZodOptional<z.ZodString>;
            appPassword: z.ZodOptional<z.ZodString>;
            appTenantId: z.ZodOptional<z.ZodString>;
            appType: z.ZodOptional<z.ZodEnum<{
                MultiTenant: "MultiTenant";
                SingleTenant: "SingleTenant";
            }>>;
            dialogOpenTimeoutMs: z.ZodOptional<z.ZodNumber>;
            federated: z.ZodOptional<z.ZodObject<{
                clientAudience: z.ZodOptional<z.ZodString>;
                clientId: z.ZodString;
            }, z.core.$strict>>;
            recorder: z.ZodDefault<z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            userName: z.ZodOptional<z.ZodString>;
            webhook: z.ZodDefault<z.ZodObject<{
                host: z.ZodDefault<z.ZodString>;
                path: z.ZodDefault<z.ZodString>;
                port: z.ZodDefault<z.ZodNumber>;
                publicUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        notes: z.ZodOptional<z.ZodString>;
        platform: z.ZodOptional<z.ZodEnum<{
            bluebubbles: "bluebubbles";
            discord: "discord";
            feishu: "feishu";
            googlechat: "googlechat";
            imessage: "imessage";
            irc: "irc";
            line: "line";
            loopback: "loopback";
            matrix: "matrix";
            mattermost: "mattermost";
            msteams: "msteams";
            nextcloudtalk: "nextcloudtalk";
            nostr: "nostr";
            signal: "signal";
            slack: "slack";
            synologychat: "synologychat";
            telegram: "telegram";
            tlon: "tlon";
            twitch: "twitch";
            webchat: "webchat";
            whatsapp: "whatsapp";
            zalo: "zalo";
            zalouser: "zalouser";
        }>>;
        slack: z.ZodOptional<z.ZodObject<{
            recorder: z.ZodDefault<z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            signingSecret: z.ZodOptional<z.ZodString>;
            webhook: z.ZodDefault<z.ZodObject<{
                host: z.ZodDefault<z.ZodString>;
                path: z.ZodDefault<z.ZodString>;
                port: z.ZodDefault<z.ZodNumber>;
                publicUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        script: z.ZodOptional<z.ZodObject<{
            commands: z.ZodObject<{
                probe: z.ZodOptional<z.ZodString>;
                send: z.ZodOptional<z.ZodString>;
                waitForInbound: z.ZodOptional<z.ZodString>;
                watch: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>;
            cwd: z.ZodOptional<z.ZodString>;
            shell: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        status: z.ZodDefault<z.ZodEnum<{
            active: "active";
            disabled: "disabled";
            planned: "planned";
        }>>;
        telegram: z.ZodOptional<z.ZodObject<{
            apiUrl: z.ZodOptional<z.ZodString>;
            botToken: z.ZodOptional<z.ZodString>;
            longPolling: z.ZodOptional<z.ZodObject<{
                allowedUpdates: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deleteWebhook: z.ZodOptional<z.ZodBoolean>;
                dropPendingUpdates: z.ZodOptional<z.ZodBoolean>;
                limit: z.ZodOptional<z.ZodNumber>;
                retryDelayMs: z.ZodOptional<z.ZodNumber>;
                timeout: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            mode: z.ZodDefault<z.ZodEnum<{
                auto: "auto";
                polling: "polling";
                webhook: "webhook";
            }>>;
            recorder: z.ZodDefault<z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            secretToken: z.ZodOptional<z.ZodString>;
            userName: z.ZodOptional<z.ZodString>;
            webhook: z.ZodDefault<z.ZodObject<{
                host: z.ZodDefault<z.ZodString>;
                path: z.ZodDefault<z.ZodString>;
                port: z.ZodDefault<z.ZodNumber>;
                publicUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        whatsapp: z.ZodOptional<z.ZodObject<{
            accessToken: z.ZodOptional<z.ZodString>;
            apiUrl: z.ZodOptional<z.ZodString>;
            apiVersion: z.ZodOptional<z.ZodString>;
            appSecret: z.ZodOptional<z.ZodString>;
            phoneNumberId: z.ZodOptional<z.ZodString>;
            recorder: z.ZodDefault<z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            userName: z.ZodOptional<z.ZodString>;
            verifyToken: z.ZodOptional<z.ZodString>;
            webhook: z.ZodDefault<z.ZodObject<{
                host: z.ZodDefault<z.ZodString>;
                path: z.ZodDefault<z.ZodString>;
                port: z.ZodDefault<z.ZodNumber>;
                publicUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        zalo: z.ZodOptional<z.ZodObject<{
            botToken: z.ZodOptional<z.ZodString>;
            recorder: z.ZodDefault<z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            userName: z.ZodOptional<z.ZodString>;
            webhook: z.ZodDefault<z.ZodObject<{
                host: z.ZodDefault<z.ZodString>;
                path: z.ZodDefault<z.ZodString>;
                port: z.ZodDefault<z.ZodNumber>;
                publicUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            webhookSecret: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>, z.ZodTransform<{
        adapter: "discord" | "feishu" | "googlechat" | "imessage" | "loopback" | "matrix" | "mattermost" | "msteams" | "script" | "slack" | "telegram" | "whatsapp" | "zalo";
        capabilities: ("agent" | "probe" | "roundtrip" | "send")[];
        discord?: {
            applicationId?: string | undefined;
            botToken?: string | undefined;
            gatewayDurationMs: number;
            mentionRoleIds?: string[] | undefined;
            publicKey?: string | undefined;
            recorder: {
                path?: string | undefined;
            };
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        env: string[];
        feishu?: {
            appId?: string | undefined;
            appSecret?: string | undefined;
            encryptKey?: string | undefined;
            recorder: {
                path?: string | undefined;
            };
            userName?: string | undefined;
            verificationToken?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        googlechat?: {
            apiUrl?: string | undefined;
            credentials?: {
                [x: string]: unknown;
                client_email: string;
                private_key: string;
                project_id?: string | undefined;
            } | undefined;
            disableSignatureVerification?: boolean | undefined;
            endpointUrl?: string | undefined;
            googleChatProjectNumber?: string | undefined;
            impersonateUser?: string | undefined;
            pubsubAudience?: string | undefined;
            pubsubServiceAccountEmail?: string | undefined;
            pubsubTopic?: string | undefined;
            recorder: {
                path?: string | undefined;
            };
            useApplicationDefaultCredentials?: boolean | undefined;
            userName?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        imessage?: {
            apiKey?: string | undefined;
            gatewayDurationMs: number;
            local?: boolean | undefined;
            recorder: {
                path?: string | undefined;
            };
            serverUrl?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        loopback?: {
            delayMs: number;
        } | undefined;
        matrix?: {
            auth?: {
                accessToken: string;
                type: "accessToken";
                userID?: string | undefined;
            } | {
                password: string;
                type: "password";
                userID?: string | undefined;
                username: string;
            } | undefined;
            baseURL?: string | undefined;
            commandPrefix?: string | undefined;
            recorder: {
                path?: string | undefined;
            };
            recoveryKey?: string | undefined;
            roomAllowlist?: string[] | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        mattermost?: {
            baseUrl?: string | undefined;
            botToken?: string | undefined;
            callbackUrl?: string | undefined;
            recorder: {
                path?: string | undefined;
            };
            userName?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
            websocket?: {
                enabled?: boolean | undefined;
                maxReconnectDelayMs?: number | undefined;
                reconnectDelayMs?: number | undefined;
            } | undefined;
        } | undefined;
        msteams?: {
            apiUrl?: string | undefined;
            appId?: string | undefined;
            appPassword?: string | undefined;
            appTenantId?: string | undefined;
            appType?: "MultiTenant" | "SingleTenant" | undefined;
            dialogOpenTimeoutMs?: number | undefined;
            federated?: {
                clientAudience?: string | undefined;
                clientId: string;
            } | undefined;
            recorder: {
                path?: string | undefined;
            };
            userName?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        notes?: string | undefined;
        slack?: {
            recorder: {
                path?: string | undefined;
            };
            signingSecret?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        script?: {
            commands: {
                probe?: string | undefined;
                send?: string | undefined;
                waitForInbound?: string | undefined;
                watch?: string | undefined;
            };
            cwd?: string | undefined;
            shell?: string | undefined;
        } | undefined;
        status: "active" | "disabled" | "planned";
        telegram?: {
            apiUrl?: string | undefined;
            botToken?: string | undefined;
            longPolling?: {
                allowedUpdates?: string[] | undefined;
                deleteWebhook?: boolean | undefined;
                dropPendingUpdates?: boolean | undefined;
                limit?: number | undefined;
                retryDelayMs?: number | undefined;
                timeout?: number | undefined;
            } | undefined;
            mode: "auto" | "polling" | "webhook";
            recorder: {
                path?: string | undefined;
            };
            secretToken?: string | undefined;
            userName?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        whatsapp?: {
            accessToken?: string | undefined;
            apiUrl?: string | undefined;
            apiVersion?: string | undefined;
            appSecret?: string | undefined;
            phoneNumberId?: string | undefined;
            recorder: {
                path?: string | undefined;
            };
            userName?: string | undefined;
            verifyToken?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        zalo?: {
            botToken?: string | undefined;
            recorder: {
                path?: string | undefined;
            };
            userName?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
            webhookSecret?: string | undefined;
        } | undefined;
        platform: "bluebubbles" | "discord" | "feishu" | "googlechat" | "imessage" | "irc" | "line" | "loopback" | "matrix" | "mattermost" | "msteams" | "nextcloudtalk" | "nostr" | "signal" | "slack" | "synologychat" | "telegram" | "tlon" | "twitch" | "webchat" | "whatsapp" | "zalo" | "zalouser";
    }, {
        adapter: "discord" | "feishu" | "googlechat" | "imessage" | "loopback" | "matrix" | "mattermost" | "msteams" | "script" | "slack" | "telegram" | "whatsapp" | "zalo";
        capabilities: ("agent" | "probe" | "roundtrip" | "send")[];
        discord?: {
            applicationId?: string | undefined;
            botToken?: string | undefined;
            gatewayDurationMs: number;
            mentionRoleIds?: string[] | undefined;
            publicKey?: string | undefined;
            recorder: {
                path?: string | undefined;
            };
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        env: string[];
        feishu?: {
            appId?: string | undefined;
            appSecret?: string | undefined;
            encryptKey?: string | undefined;
            recorder: {
                path?: string | undefined;
            };
            userName?: string | undefined;
            verificationToken?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        googlechat?: {
            apiUrl?: string | undefined;
            credentials?: {
                [x: string]: unknown;
                client_email: string;
                private_key: string;
                project_id?: string | undefined;
            } | undefined;
            disableSignatureVerification?: boolean | undefined;
            endpointUrl?: string | undefined;
            googleChatProjectNumber?: string | undefined;
            impersonateUser?: string | undefined;
            pubsubAudience?: string | undefined;
            pubsubServiceAccountEmail?: string | undefined;
            pubsubTopic?: string | undefined;
            recorder: {
                path?: string | undefined;
            };
            useApplicationDefaultCredentials?: boolean | undefined;
            userName?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        imessage?: {
            apiKey?: string | undefined;
            gatewayDurationMs: number;
            local?: boolean | undefined;
            recorder: {
                path?: string | undefined;
            };
            serverUrl?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        loopback?: {
            delayMs: number;
        } | undefined;
        matrix?: {
            auth?: {
                accessToken: string;
                type: "accessToken";
                userID?: string | undefined;
            } | {
                password: string;
                type: "password";
                userID?: string | undefined;
                username: string;
            } | undefined;
            baseURL?: string | undefined;
            commandPrefix?: string | undefined;
            recorder: {
                path?: string | undefined;
            };
            recoveryKey?: string | undefined;
            roomAllowlist?: string[] | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        mattermost?: {
            baseUrl?: string | undefined;
            botToken?: string | undefined;
            callbackUrl?: string | undefined;
            recorder: {
                path?: string | undefined;
            };
            userName?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
            websocket?: {
                enabled?: boolean | undefined;
                maxReconnectDelayMs?: number | undefined;
                reconnectDelayMs?: number | undefined;
            } | undefined;
        } | undefined;
        msteams?: {
            apiUrl?: string | undefined;
            appId?: string | undefined;
            appPassword?: string | undefined;
            appTenantId?: string | undefined;
            appType?: "MultiTenant" | "SingleTenant" | undefined;
            dialogOpenTimeoutMs?: number | undefined;
            federated?: {
                clientAudience?: string | undefined;
                clientId: string;
            } | undefined;
            recorder: {
                path?: string | undefined;
            };
            userName?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        notes?: string | undefined;
        platform?: "bluebubbles" | "discord" | "feishu" | "googlechat" | "imessage" | "irc" | "line" | "loopback" | "matrix" | "mattermost" | "msteams" | "nextcloudtalk" | "nostr" | "signal" | "slack" | "synologychat" | "telegram" | "tlon" | "twitch" | "webchat" | "whatsapp" | "zalo" | "zalouser" | undefined;
        slack?: {
            recorder: {
                path?: string | undefined;
            };
            signingSecret?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        script?: {
            commands: {
                probe?: string | undefined;
                send?: string | undefined;
                waitForInbound?: string | undefined;
                watch?: string | undefined;
            };
            cwd?: string | undefined;
            shell?: string | undefined;
        } | undefined;
        status: "active" | "disabled" | "planned";
        telegram?: {
            apiUrl?: string | undefined;
            botToken?: string | undefined;
            longPolling?: {
                allowedUpdates?: string[] | undefined;
                deleteWebhook?: boolean | undefined;
                dropPendingUpdates?: boolean | undefined;
                limit?: number | undefined;
                retryDelayMs?: number | undefined;
                timeout?: number | undefined;
            } | undefined;
            mode: "auto" | "polling" | "webhook";
            recorder: {
                path?: string | undefined;
            };
            secretToken?: string | undefined;
            userName?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        whatsapp?: {
            accessToken?: string | undefined;
            apiUrl?: string | undefined;
            apiVersion?: string | undefined;
            appSecret?: string | undefined;
            phoneNumberId?: string | undefined;
            recorder: {
                path?: string | undefined;
            };
            userName?: string | undefined;
            verifyToken?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
        } | undefined;
        zalo?: {
            botToken?: string | undefined;
            recorder: {
                path?: string | undefined;
            };
            userName?: string | undefined;
            webhook: {
                host: string;
                path: string;
                port: number;
                publicUrl?: string | undefined;
            };
            webhookSecret?: string | undefined;
        } | undefined;
    }>>>>;
    userName: z.ZodDefault<z.ZodString>;
}, z.core.$strict>>;
export type BuiltinAdapterId = BuiltinAdapterName;
export type FixtureDefinition = z.infer<typeof FixtureSchema>;
export type FixtureMode = (typeof FIXTURE_MODES)[number];
export type InboundAuthor = (typeof INBOUND_AUTHORS)[number];
export type ManifestDefinition = z.infer<typeof ManifestSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProviderPlatform = ProviderPlatformName;
export {};
