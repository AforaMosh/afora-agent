import { Buffer } from "node:buffer";
import { ProtocolAddress, SessionCipher, SessionRecord } from "libsignal";
import { aesDecryptGCM, aesEncryptGCM, Curve, encodeBigEndian, hkdf, NOISE_MODE, NOISE_WA_HEADER, sha256, signedKeyPair, } from "./whatsapp-wire/crypto.js";
import { decodeBinaryNode, encodeBinaryNode, S_WHATSAPP_NET, } from "./whatsapp-wire/binary-node.js";
import { decodeHandshakeMessage, encodeHandshakeMessage } from "./whatsapp-wire/handshake.js";
import { KEY_BUNDLE_TYPE, xmppPreKey, xmppSignedPreKey } from "./whatsapp-wire/signal.js";
import { WebSocket, WebSocketServer } from "ws";
import { closeWebSocketServer } from "./websocket.js";
import { canonicalizeWhatsAppUserCorrelationJid } from "./whatsapp-jid.js";
// Keep the local server independent from Baileys at runtime. Tests use Baileys
// as a black-box client to verify this narrow WhatsApp Web wire subset.
const EMPTY_BUFFER = Buffer.alloc(0);
const IV_LENGTH = 12;
const MAX_PENDING_INBOUND_MESSAGES = 1_000;
export const MAX_WHATSAPP_NOISE_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_WHATSAPP_WEBSOCKET_BUFFERED_BYTES = 4 * 1024 * 1024;
export const MAX_WHATSAPP_WEBSOCKET_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_WHATSAPP_NOISE_BUFFER_CHUNKS = 1_024;
export const MAX_WHATSAPP_NOISE_FRAMES_PER_MESSAGE = 1_024;
export const WHATSAPP_WEBSOCKET_SEND_TIMEOUT_MS = 5_000;
const MAX_PENDING_WEBSOCKET_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_WEBSOCKET_MESSAGES = 32;
export const MAX_WHATSAPP_WEBSOCKET_FRAGMENTS = 1_024;
export const MAX_WHATSAPP_SIGNAL_BUNDLES = 1_024;
export const MAX_WHATSAPP_WEBSOCKET_CLOSE_REASON_BYTES = 123;
const WHATSAPP_NOISE_CERT_CHAIN = Buffer.from("CncKMwjjAhADGiCRKg7Kg1iu4CSulwLBaxX51Tefw6VXGgZqcr5OEbXIRiDQ04bOBijQjZ/TBhJA34Bj82jAHhLpCWBNVBlGnFDieamd8+138S57uMt9ke9mrn5r4+VepwBPKEgHjob6bR70rlCmWDkxZv+CfVjIAxJ2CjIIAxAAGiAcUamsMDmUxsjQuS6hh4pTNHZZnMWZ++o1mX2aqQzOYiCAka6+Bij/3rfcBhJAJw8pRkhTn+1IcOJQVN1OlZg6uikYnCumyO7acFVVX3U3QPXsGSq2TCbCbWrebSC593Su43EgprIDlfU8ZgWFBw==", "base64");
export function resolveMaxPendingWhatsAppInboundMessages(value) {
    const resolved = value ?? MAX_PENDING_INBOUND_MESSAGES;
    if (!Number.isSafeInteger(resolved) || resolved < 1) {
        throw new Error("WhatsApp maxPendingInboundMessages must be a positive safe integer.");
    }
    return resolved;
}
export class WhatsAppSignalBundleStore {
    maxBundles;
    #bundles = new Map();
    #lidByPhoneNumber = new Map();
    #sessions = new Map();
    constructor(maxBundles = MAX_WHATSAPP_SIGNAL_BUNDLES) {
        this.maxBundles = maxBundles;
        if (!Number.isSafeInteger(maxBundles) || maxBundles < 1) {
            throw new Error("WhatsApp maxSignalBundles must be a positive safe integer.");
        }
    }
    get size() {
        return this.#bundles.size;
    }
    associateLid(phoneNumberJid, lidJid) {
        const phoneNumber = canonicalizeWhatsAppUserCorrelationJid(phoneNumberJid);
        const lid = canonicalizeWhatsAppUserCorrelationJid(lidJid);
        if (!phoneNumber?.endsWith("@s.whatsapp.net") || !lid?.endsWith("@lid")) {
            throw new Error("Invalid WhatsApp PN/LID signal mapping.");
        }
        this.#lidByPhoneNumber.set(signalBundleIdentityKey(phoneNumber), signalBundleIdentityKey(lid));
    }
    resolveMany(jids) {
        const uniqueNewIdentities = new Set();
        const identityKeys = [];
        for (const jid of jids) {
            const canonical = canonicalizeWhatsAppUserCorrelationJid(jid);
            if (!canonical) {
                throw new Error(`Invalid WhatsApp signal bundle JID: ${jid}.`);
            }
            const identityKey = signalBundleIdentityKey(canonical);
            identityKeys.push(identityKey);
            if (!this.#bundles.has(identityKey)) {
                uniqueNewIdentities.add(identityKey);
            }
        }
        if (this.#bundles.size + uniqueNewIdentities.size > this.maxBundles) {
            throw new Error(`WhatsApp signal bundle limit exceeded (${this.maxBundles}).`);
        }
        return identityKeys.map((identityKey) => this.#resolve(identityKey));
    }
    async decryptDirectMessage(params) {
        const recipientJid = canonicalizeWhatsAppUserCorrelationJid(params.recipientJid);
        const recipientIdentityKey = recipientJid ? signalBundleIdentityKey(recipientJid) : undefined;
        const mappedLidIdentityKey = recipientIdentityKey
            ? this.#lidByPhoneNumber.get(recipientIdentityKey)
            : undefined;
        const identityKey = mappedLidIdentityKey && this.#bundles.has(mappedLidIdentityKey)
            ? mappedLidIdentityKey
            : recipientIdentityKey;
        const bundle = identityKey ? this.#bundles.get(identityKey) : undefined;
        if (!identityKey || !bundle) {
            return undefined;
        }
        const remoteAddress = signalProtocolAddress(params.remoteJid);
        if (!remoteAddress) {
            return undefined;
        }
        const sessions = this.#sessions.get(identityKey) ?? new Map();
        this.#sessions.set(identityKey, sessions);
        const stagedSessions = new Map();
        const storage = {
            async loadSession(id) {
                const session = stagedSessions.get(id) ?? sessions.get(id);
                return session ? cloneSignalSession(session) : undefined;
            },
            async storeSession(id, session) {
                stagedSessions.set(id, cloneSignalSession(session));
            },
            isTrustedIdentity: () => true,
            async loadPreKey(id) {
                if (String(id) !== String(bundle.preKeyId)) {
                    return undefined;
                }
                return signalKeyPair(bundle.preKey);
            },
            removePreKey: () => undefined,
            loadSignedPreKey: () => signalKeyPair(bundle.signedPreKey.keyPair),
            getOurRegistrationId: () => bundle.registrationId,
            getOurIdentity: () => signalKeyPair(bundle.identityKey),
        };
        const cipher = new SessionCipher(storage, new ProtocolAddress(remoteAddress.name, remoteAddress.deviceId));
        const plaintext = params.type === "pkmsg"
            ? await cipher.decryptPreKeyWhisperMessage(params.ciphertext)
            : await cipher.decryptWhisperMessage(params.ciphertext);
        for (const [id, session] of stagedSessions) {
            sessions.set(id, session);
        }
        return plaintext;
    }
    #resolve(bundleKey) {
        const existing = this.#bundles.get(bundleKey);
        if (existing) {
            return existing;
        }
        const identityKey = Curve.generateKeyPair();
        const bundle = {
            identityKey,
            preKey: Curve.generateKeyPair(),
            preKeyId: 1,
            registrationId: 1,
            signedPreKey: signedKeyPair(identityKey, 1),
        };
        this.#bundles.set(bundleKey, bundle);
        return bundle;
    }
}
export function createSerializedMessageHandler(processMessage, onError, options = {}) {
    const maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_WEBSOCKET_BYTES;
    const maxPendingMessages = options.maxPendingMessages ?? MAX_PENDING_WEBSOCKET_MESSAGES;
    const sizeOf = options.sizeOf ?? (() => 1);
    let failed = false;
    let pendingBytes = 0;
    let pendingMessages = 0;
    let pending = Promise.resolve();
    const fail = (error) => {
        if (!failed) {
            failed = true;
            onError(error);
        }
    };
    return (message) => {
        if (failed) {
            return pending;
        }
        const messageBytes = sizeOf(message);
        if (!Number.isSafeInteger(messageBytes) || messageBytes < 0) {
            fail(new Error("WhatsApp WebSocket message size must be a non-negative safe integer."));
            return pending;
        }
        if (pendingMessages >= maxPendingMessages || pendingBytes + messageBytes > maxPendingBytes) {
            fail(new Error("WhatsApp WebSocket inbound backlog limit exceeded."));
            return pending;
        }
        pendingMessages += 1;
        pendingBytes += messageBytes;
        const next = pending
            .then(async () => {
            if (!failed) {
                await processMessage(message);
            }
        })
            .finally(() => {
            pendingMessages -= 1;
            pendingBytes -= messageBytes;
        });
        pending = next.catch((error) => {
            fail(error);
        });
        return pending;
    };
}
export class WhatsAppNoiseFrameDecoder {
    #bufferedBytes = 0;
    #chunks = [];
    #expectIntro = true;
    #offset = 0;
    get bufferedBytes() {
        return this.#bufferedBytes;
    }
    decodeFrames(data) {
        let chunk = rawDataToBuffer(data);
        if (this.#expectIntro) {
            chunk = removeNoiseIntroHeader(chunk);
            this.#expectIntro = false;
        }
        if (chunk.length > 0) {
            if (this.#chunks.length >= MAX_WHATSAPP_NOISE_BUFFER_CHUNKS) {
                throw new Error(`WhatsApp Noise buffer exceeds ${MAX_WHATSAPP_NOISE_BUFFER_CHUNKS} chunks.`);
            }
            this.#chunks.push(chunk);
            this.#bufferedBytes += chunk.length;
        }
        const frames = [];
        while (this.#bufferedBytes >= 3) {
            const size = (this.#peekByte(0) << 16) | (this.#peekByte(1) << 8) | this.#peekByte(2);
            if (size > MAX_WHATSAPP_NOISE_FRAME_BYTES) {
                throw new Error(`WhatsApp Noise frame exceeds ${MAX_WHATSAPP_NOISE_FRAME_BYTES} bytes.`);
            }
            if (this.#bufferedBytes < size + 3) {
                break;
            }
            if (frames.length >= MAX_WHATSAPP_NOISE_FRAMES_PER_MESSAGE) {
                throw new Error(`WhatsApp Noise message exceeds ${MAX_WHATSAPP_NOISE_FRAMES_PER_MESSAGE} frames.`);
            }
            this.#consume(3);
            frames.push(this.#read(size));
        }
        return frames;
    }
    #consume(length) {
        let remaining = length;
        while (remaining > 0) {
            const chunk = this.#chunks[0];
            if (!chunk) {
                throw new Error("Unexpected end of WhatsApp Noise frame buffer.");
            }
            const available = chunk.length - this.#offset;
            const consumed = Math.min(available, remaining);
            this.#offset += consumed;
            this.#bufferedBytes -= consumed;
            remaining -= consumed;
            if (this.#offset === chunk.length) {
                this.#chunks.shift();
                this.#offset = 0;
            }
        }
    }
    #peekByte(index) {
        let remaining = index + this.#offset;
        for (const chunk of this.#chunks) {
            if (remaining < chunk.length) {
                return chunk[remaining];
            }
            remaining -= chunk.length;
        }
        throw new Error("Unexpected end of WhatsApp Noise frame buffer.");
    }
    #read(length) {
        const result = Buffer.allocUnsafe(length);
        let resultOffset = 0;
        while (resultOffset < length) {
            const chunk = this.#chunks[0];
            if (!chunk) {
                throw new Error("Unexpected end of WhatsApp Noise frame buffer.");
            }
            const copied = chunk.copy(result, resultOffset, this.#offset, Math.min(chunk.length, this.#offset + length - resultOffset));
            this.#offset += copied;
            this.#bufferedBytes -= copied;
            resultOffset += copied;
            if (this.#offset === chunk.length) {
                this.#chunks.shift();
                this.#offset = 0;
            }
        }
        return result;
    }
}
class TransportState {
    encKey;
    decKey;
    #readCounter = 0;
    #writeCounter = 0;
    constructor(encKey, decKey) {
        this.encKey = encKey;
        this.decKey = decKey;
    }
    decrypt(ciphertext) {
        const iv = createIv(this.#readCounter++);
        return aesDecryptGCM(Buffer.from(ciphertext), this.decKey, iv, EMPTY_BUFFER);
    }
    encrypt(plaintext) {
        const iv = createIv(this.#writeCounter++);
        return aesEncryptGCM(Buffer.from(plaintext), this.encKey, iv, EMPTY_BUFFER);
    }
}
class BaileysNoiseServer {
    #counter = 0;
    #decKey;
    #encKey;
    #frames = new WhatsAppNoiseFrameDecoder();
    #hash;
    #salt;
    #serverEphemeralKey;
    #serverStaticKey;
    #transport;
    constructor() {
        const initial = Buffer.from(NOISE_MODE);
        this.#hash = Buffer.from(initial.byteLength === 32 ? initial : sha256(initial));
        this.#salt = this.#hash;
        this.#encKey = this.#hash;
        this.#decKey = this.#hash;
        this.#authenticate(NOISE_WA_HEADER);
    }
    decodeFrames(data) {
        return this.#frames.decodeFrames(data);
    }
    async decodeTransportNode(frame) {
        if (!this.#transport) {
            throw new Error("Cannot decode a Baileys node before the Noise transport is ready.");
        }
        return await decodeBinaryNode(this.#transport.decrypt(frame));
    }
    finishClientHandshake(frame) {
        const message = decodeHandshakeMessage(frame);
        const finish = message.clientFinish;
        if (!finish?.staticKey || !finish.payload || !this.#serverEphemeralKey) {
            throw new Error("Invalid Baileys client finish handshake.");
        }
        const clientNoisePublic = this.#decrypt(finish.staticKey);
        this.#mixIntoKey(Curve.sharedKey(this.#serverEphemeralKey.private, clientNoisePublic));
        this.#decrypt(finish.payload);
        const [writeKey, readKey] = this.#localHKDF(EMPTY_BUFFER);
        this.#transport = new TransportState(readKey, writeKey);
    }
    createServerHello(frame) {
        const message = decodeHandshakeMessage(frame);
        const clientHello = message.clientHello;
        if (!clientHello?.ephemeral) {
            throw new Error("Invalid Baileys client hello handshake.");
        }
        this.#authenticate(clientHello.ephemeral);
        this.#serverEphemeralKey = Curve.generateKeyPair();
        this.#serverStaticKey = Curve.generateKeyPair();
        this.#authenticate(this.#serverEphemeralKey.public);
        this.#mixIntoKey(Curve.sharedKey(this.#serverEphemeralKey.private, clientHello.ephemeral));
        const staticKey = this.#encrypt(this.#serverStaticKey.public);
        this.#mixIntoKey(Curve.sharedKey(this.#serverStaticKey.private, clientHello.ephemeral));
        const payload = this.#encrypt(WHATSAPP_NOISE_CERT_CHAIN);
        return encodeLengthPrefixed(encodeHandshakeMessage({
            serverHello: {
                ephemeral: this.#serverEphemeralKey.public,
                payload,
                staticKey,
            },
        }));
    }
    encodeNode(node) {
        if (!this.#transport) {
            throw new Error("Cannot encode a Baileys node before the Noise transport is ready.");
        }
        return encodeLengthPrefixed(this.#transport.encrypt(encodeBinaryNode(node)));
    }
    #authenticate(data) {
        this.#hash = sha256(Buffer.concat([this.#hash, Buffer.from(data)]));
    }
    #decrypt(ciphertext) {
        const result = aesDecryptGCM(Buffer.from(ciphertext), this.#decKey, createIv(this.#counter++), this.#hash);
        this.#authenticate(ciphertext);
        return result;
    }
    #encrypt(plaintext) {
        const result = aesEncryptGCM(Buffer.from(plaintext), this.#encKey, createIv(this.#counter++), this.#hash);
        this.#authenticate(result);
        return result;
    }
    #localHKDF(data) {
        const key = hkdf(Buffer.from(data), 64, { info: "", salt: this.#salt });
        return [Buffer.from(key.subarray(0, 32)), Buffer.from(key.subarray(32))];
    }
    #mixIntoKey(data) {
        const [writeKey, readKey] = this.#localHKDF(data);
        this.#salt = writeKey;
        this.#encKey = readKey;
        this.#decKey = readKey;
        this.#counter = 0;
    }
}
class WhatsAppBaileysWebSocketSession {
    socket;
    params;
    #handshakeState = "client-hello";
    #handleSerializedMessage;
    #noise = new BaileysNoiseServer();
    constructor(socket, params) {
        this.socket = socket;
        this.params = params;
        this.#handleSerializedMessage = createSerializedMessageHandler((data) => this.#handleMessage(data), (error) => {
            const close = resolveWhatsAppWebSocketClose(error);
            this.socket.close(close.code, close.reason);
        }, {
            sizeOf: rawDataByteLength,
        });
    }
    get isOpen() {
        return this.#handshakeState === "open" && this.socket.readyState === WebSocket.OPEN;
    }
    handleMessage(data) {
        void this.#handleSerializedMessage(data);
    }
    async deliverInboundMessage(message) {
        if (!this.isOpen) {
            return false;
        }
        try {
            await this.#sendNode(createInboundMessageNode(message));
            return true;
        }
        catch {
            this.socket.terminate();
            return false;
        }
    }
    async #handleMessage(data) {
        for (const frame of this.#noise.decodeFrames(data)) {
            if (this.#handshakeState === "client-hello") {
                await sendWhatsAppWebSocketPayload(this.socket, this.#noise.createServerHello(frame));
                this.#handshakeState = "client-finish";
                continue;
            }
            if (this.#handshakeState === "client-finish") {
                this.#noise.finishClientHandshake(frame);
                this.#handshakeState = "open";
                await this.#sendNode({
                    attrs: {
                        lid: lidForJid(this.params.selfJid),
                        t: unixSeconds(),
                    },
                    tag: "success",
                });
                await this.#sendNode({
                    attrs: {},
                    content: [{ attrs: { count: "0" }, tag: "offline" }],
                    tag: "ib",
                });
                this.params.onOpen(this);
                continue;
            }
            await this.#handleNode(await this.#noise.decodeTransportNode(frame));
        }
    }
    async #handleNode(node) {
        await this.#recordNode(node);
        if (node.tag === "iq") {
            await this.#sendNode(this.#createIqResult(node));
            return;
        }
        if (node.tag === "message") {
            const peer = requireAttr(node, "to");
            const normalizedMessage = await normalizeAcceptedBaileysMessage({
                node,
                remoteJid: this.params.selfJid,
                signalBundles: this.params.signalBundles,
            });
            await this.#sendNode({
                attrs: {
                    class: "message",
                    from: peer,
                    id: requireAttr(node, "id"),
                    to: this.params.selfJid,
                    ...(node.attrs.type ? { type: node.attrs.type } : {}),
                },
                tag: "ack",
            });
            if (normalizedMessage) {
                await this.params.appendEvent({
                    accepted: true,
                    at: new Date().toISOString(),
                    body: normalizedMessage,
                    method: "WEBSOCKET",
                    path: this.params.path,
                    query: {},
                    type: "api",
                });
            }
        }
    }
    #createIqResult(node) {
        const child = firstChild(node);
        const id = requireAttr(node, "id");
        const attrs = {
            from: node.attrs.to ?? S_WHATSAPP_NET,
            id,
            t: unixSeconds(),
            type: "result",
        };
        if (node.attrs.xmlns === "encrypt" && child?.tag === "count") {
            return { attrs, content: [{ attrs: { value: "50" }, tag: "count" }], tag: "iq" };
        }
        if (node.attrs.xmlns === "encrypt" && child?.tag === "digest") {
            return { attrs, content: [{ attrs: {}, tag: "digest" }], tag: "iq" };
        }
        if (node.attrs.xmlns === "encrypt" && child?.tag === "key") {
            try {
                return { attrs, content: [this.#createKeyList(child)], tag: "iq" };
            }
            catch (error) {
                return {
                    attrs: { ...attrs, type: "error" },
                    content: [
                        {
                            attrs: {
                                code: "400",
                                text: error instanceof Error ? error.message : String(error),
                                type: "modify",
                            },
                            tag: "error",
                        },
                    ],
                    tag: "iq",
                };
            }
        }
        if (node.attrs.xmlns === "usync" && child?.tag === "usync") {
            return { attrs, content: [this.#createUSyncResult(child)], tag: "iq" };
        }
        if (node.attrs.xmlns === "abt") {
            return {
                attrs,
                content: [
                    {
                        attrs: { hash: "mock" },
                        content: [
                            { attrs: { name: "10518", value: "false" }, tag: "prop" },
                            { attrs: { name: "14303", value: "false" }, tag: "prop" },
                        ],
                        tag: "props",
                    },
                ],
                tag: "iq",
            };
        }
        if (node.attrs.xmlns === "blocklist") {
            return { attrs, content: [{ attrs: {}, content: [], tag: "list" }], tag: "iq" };
        }
        if (node.attrs.xmlns === "privacy") {
            return {
                attrs,
                content: [
                    {
                        attrs: {},
                        content: [
                            { attrs: { name: "readreceipts", value: "all" }, tag: "category" },
                            { attrs: { name: "profile", value: "all" }, tag: "category" },
                        ],
                        tag: "privacy",
                    },
                ],
                tag: "iq",
            };
        }
        if (node.attrs.xmlns === "w:m" && child?.tag === "media_conn") {
            return {
                attrs,
                content: [
                    {
                        attrs: { auth: "mock", ttl: "3600" },
                        content: [
                            {
                                attrs: {
                                    hostname: "127.0.0.1",
                                    maxContentLengthBytes: "10485760",
                                },
                                tag: "host",
                            },
                        ],
                        tag: "media_conn",
                    },
                ],
                tag: "iq",
            };
        }
        if (node.attrs.xmlns === "w:g2") {
            if (node.attrs.type !== "get" || child?.tag !== "query") {
                return {
                    attrs: { ...attrs, type: "error" },
                    content: [
                        {
                            attrs: { code: "501", text: "unsupported group operation", type: "cancel" },
                            tag: "error",
                        },
                    ],
                    tag: "iq",
                };
            }
            return {
                attrs,
                content: [
                    {
                        attrs: {
                            id: node.attrs.to ?? "120363000000000000@g.us",
                            owner: this.params.selfJid,
                            subject: "Test Group",
                            s_t: unixSeconds(),
                        },
                        content: [{ attrs: { jid: this.params.selfJid }, tag: "participant" }],
                        tag: "group",
                    },
                ],
                tag: "iq",
            };
        }
        return { attrs, tag: "iq" };
    }
    #createKeyList(keyNode) {
        const users = children(keyNode).filter((child) => child.tag === "user");
        const jids = users.map((userNode) => requireAttr(userNode, "jid"));
        const bundles = this.params.signalBundles.resolveMany(jids);
        return {
            attrs: {},
            content: jids.map((jid, index) => this.#createKeyUser(jid, bundles[index])),
            tag: "list",
        };
    }
    #createKeyUser(jid, bundle) {
        return {
            attrs: { jid },
            content: [
                { attrs: {}, content: encodeBigEndian(bundle.registrationId), tag: "registration" },
                { attrs: {}, content: KEY_BUNDLE_TYPE, tag: "type" },
                { attrs: {}, content: bundle.identityKey.public, tag: "identity" },
                xmppSignedPreKey(bundle.signedPreKey),
                xmppPreKey(bundle.preKey, bundle.preKeyId),
            ],
            tag: "user",
        };
    }
    #createUSyncResult(usyncNode) {
        const requestList = children(usyncNode).find((child) => child.tag === "list");
        const requestedUsers = requestList
            ? children(requestList).filter((child) => child.tag === "user")
            : [];
        return {
            attrs: {
                index: usyncNode.attrs.index ?? "0",
                last: "true",
                sid: usyncNode.attrs.sid ?? "mock",
            },
            content: [
                {
                    attrs: {},
                    content: requestedUsers.map((user) => this.#createUSyncUser(requireAttr(user, "jid"))),
                    tag: "list",
                },
            ],
            tag: "usync",
        };
    }
    #createUSyncUser(jid) {
        const lid = lidForJid(jid);
        if (canonicalizeWhatsAppUserCorrelationJid(jid)?.endsWith("@s.whatsapp.net")) {
            this.params.signalBundles.associateLid(jid, lid);
        }
        return {
            attrs: { jid },
            content: [
                {
                    attrs: {},
                    content: [
                        {
                            attrs: {},
                            content: [{ attrs: { id: "0" }, tag: "device" }],
                            tag: "device-list",
                        },
                    ],
                    tag: "devices",
                },
                { attrs: { val: lid }, tag: "lid" },
            ],
            tag: "user",
        };
    }
    async #recordNode(node) {
        await this.params.appendEvent({
            at: new Date().toISOString(),
            body: sanitizeNodeForJson(node),
            method: "WEBSOCKET",
            path: this.params.path,
            query: {},
            type: "api",
        });
    }
    async #sendNode(node) {
        await sendWhatsAppWebSocketPayload(this.socket, this.#noise.encodeNode(node));
    }
}
export async function sendWhatsAppWebSocketPayload(socket, payload) {
    if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("WhatsApp WebSocket is not open.");
    }
    if (socket.bufferedAmount + payload.byteLength > MAX_WHATSAPP_WEBSOCKET_BUFFERED_BYTES) {
        socket.terminate();
        throw new Error("WhatsApp WebSocket outbound buffer limit exceeded.");
    }
    await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            if (error) {
                reject(error);
            }
            else {
                resolve();
            }
        };
        const timeout = setTimeout(() => {
            socket.terminate();
            finish(new Error("WhatsApp WebSocket send timed out."));
        }, WHATSAPP_WEBSOCKET_SEND_TIMEOUT_MS);
        try {
            socket.send(payload, finish);
        }
        catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
        }
    });
}
export function resolveWhatsAppWebSocketClose(error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /(?:backlog|exceeds|limit|payload is too large|too many)/iu.test(message)
        ? 1009
        : /(?:baileys|binary node|handshake|noise|protocol|unexpected end|unsupported|invalid)/iu.test(message)
            ? 1002
            : 1011;
    return { code, reason: truncateWebSocketCloseReason(message) };
}
function truncateWebSocketCloseReason(reason) {
    let result = "";
    for (const character of reason) {
        if (Buffer.byteLength(result + character) > MAX_WHATSAPP_WEBSOCKET_CLOSE_REASON_BYTES) {
            break;
        }
        result += character;
    }
    return result;
}
export function attachWhatsAppBaileysWebSocketServer(params) {
    const signalBundles = new WhatsAppSignalBundleStore();
    const sessions = new Set();
    const pendingMessages = [];
    const maxPendingInboundMessages = resolveMaxPendingWhatsAppInboundMessages(params.maxPendingInboundMessages);
    let pendingReservations = 0;
    let closing = false;
    let flushPromise = Promise.resolve();
    const webSocketServerOptions = {
        maxBufferedChunks: MAX_WHATSAPP_WEBSOCKET_FRAGMENTS,
        maxFragments: MAX_WHATSAPP_WEBSOCKET_FRAGMENTS,
        maxPayload: MAX_WHATSAPP_WEBSOCKET_MESSAGE_BYTES,
        noServer: true,
    };
    const wss = new WebSocketServer(webSocketServerOptions);
    const flushPendingMessages = () => {
        const next = flushPromise.then(async () => {
            while (pendingMessages.length > 0) {
                if (closing) {
                    return;
                }
                const message = pendingMessages[0];
                if (!message) {
                    return;
                }
                const results = await Promise.all([...sessions].map((session) => session.deliverInboundMessage(message)));
                if (!results.some(Boolean)) {
                    return;
                }
                pendingMessages.shift();
            }
        });
        flushPromise = next.catch(() => undefined);
        return next;
    };
    const rejectUpgrade = (socket, response) => {
        socket.end(response, () => socket.destroy());
    };
    const handleUpgrade = (request, socket, head) => {
        const url = parseWhatsAppWebSocketUpgradeUrl(request.url);
        if (!url) {
            rejectUpgrade(socket, "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
            return;
        }
        if (url.pathname !== params.path) {
            socket.destroy();
            return;
        }
        if (url.searchParams.get("access_token") !== params.accessToken) {
            rejectUpgrade(socket, "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit("connection", ws, request);
        });
    };
    params.httpServer.on("upgrade", handleUpgrade);
    wss.on("connection", (socket) => {
        const session = new WhatsAppBaileysWebSocketSession(socket, {
            appendEvent: params.appendEvent,
            onOpen: () => {
                void flushPendingMessages();
            },
            path: params.path,
            selfJid: params.selfJid,
            signalBundles,
        });
        sessions.add(session);
        socket.once("close", () => sessions.delete(session));
        socket.on("error", () => {
            sessions.delete(session);
            socket.terminate();
        });
        socket.on("message", (data) => session.handleMessage(data));
    });
    return {
        async close() {
            closing = true;
            params.httpServer.off("upgrade", handleUpgrade);
            pendingMessages.length = 0;
            await closeWebSocketServer(wss);
            await flushPromise;
        },
        prepareInboundMessage(message) {
            if (pendingMessages.length + pendingReservations >= maxPendingInboundMessages) {
                return undefined;
            }
            let reserved = true;
            let settled = false;
            pendingReservations += 1;
            const releaseReservation = () => {
                if (reserved) {
                    reserved = false;
                    pendingReservations -= 1;
                }
            };
            return {
                cancel() {
                    if (!settled) {
                        settled = true;
                        releaseReservation();
                    }
                },
                async commit() {
                    if (settled) {
                        throw new Error("WhatsApp inbound delivery reservation is already settled.");
                    }
                    settled = true;
                    try {
                        releaseReservation();
                        if (pendingMessages.length >= maxPendingInboundMessages) {
                            throw new Error("WhatsApp inbound delivery reservation exceeded queue capacity.");
                        }
                        pendingMessages.push(message);
                        await flushPendingMessages();
                        return pendingMessages.includes(message) ? "queued" : "delivered";
                    }
                    finally {
                        releaseReservation();
                    }
                },
            };
        },
    };
}
export function parseWhatsAppWebSocketUpgradeUrl(requestTarget) {
    try {
        return new URL(requestTarget ?? "/", "http://127.0.0.1");
    }
    catch {
        return undefined;
    }
}
function rawDataByteLength(data) {
    if (Array.isArray(data)) {
        return data.reduce((total, chunk) => total + chunk.byteLength, 0);
    }
    return data.byteLength;
}
function rawDataToBuffer(data) {
    if (Buffer.isBuffer(data)) {
        return data;
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data);
    }
    return Buffer.from(data);
}
function removeNoiseIntroHeader(chunk) {
    if (chunk.subarray(0, NOISE_WA_HEADER.length).equals(NOISE_WA_HEADER)) {
        return chunk.subarray(NOISE_WA_HEADER.length);
    }
    if (chunk.length >= 11 && chunk.subarray(0, 2).toString("utf8") === "ED" && chunk[3] === 1) {
        const routingInfoPrefix = chunk[4];
        if (routingInfoPrefix === undefined) {
            throw new Error("Invalid Baileys Noise routing header.");
        }
        const routingInfoLength = (routingInfoPrefix << 16) | chunk.readUInt16BE(5);
        const headerLength = 7 + routingInfoLength + NOISE_WA_HEADER.length;
        if (chunk.subarray(headerLength - NOISE_WA_HEADER.length, headerLength).equals(NOISE_WA_HEADER)) {
            return chunk.subarray(headerLength);
        }
    }
    throw new Error("Invalid Baileys Noise intro header.");
}
function children(node) {
    return Array.isArray(node.content) ? node.content : [];
}
async function normalizeAcceptedBaileysMessage(params) {
    const peer = canonicalizeWhatsAppUserCorrelationJid(params.node.attrs.to ?? "");
    const messageId = params.node.attrs.id;
    if (!peer || !messageId) {
        return undefined;
    }
    const candidates = encryptedMessageCandidates(params.node);
    const remoteCorrelationJid = canonicalizeWhatsAppUserCorrelationJid(params.remoteJid);
    candidates.sort((left, right) => {
        const leftIsSelf = canonicalizeWhatsAppUserCorrelationJid(left.recipientJid) === remoteCorrelationJid;
        const rightIsSelf = canonicalizeWhatsAppUserCorrelationJid(right.recipientJid) === remoteCorrelationJid;
        return Number(leftIsSelf) - Number(rightIsSelf);
    });
    for (const candidate of candidates) {
        try {
            const decrypted = await params.signalBundles.decryptDirectMessage({
                ciphertext: candidate.ciphertext,
                recipientJid: candidate.recipientJid,
                remoteJid: params.remoteJid,
                type: candidate.type,
            });
            const text = decrypted ? readWhatsAppConversation(unpadRandomMax16(decrypted)) : undefined;
            if (text) {
                return {
                    key: {
                        fromMe: true,
                        id: messageId,
                        remoteJid: peer,
                    },
                    message: { conversation: text },
                    messageTimestamp: Math.floor(Date.now() / 1000),
                };
            }
        }
        catch {
            // Other participant envelopes may not belong to this mock server identity.
        }
    }
    return undefined;
}
function encryptedMessageCandidates(node) {
    const result = [];
    const visit = (current, recipientJid) => {
        const nextRecipient = current.tag === "to" ? current.attrs.jid : recipientJid;
        if (current.tag === "enc" &&
            nextRecipient &&
            (current.attrs.type === "msg" || current.attrs.type === "pkmsg") &&
            current.content instanceof Uint8Array) {
            result.push({
                ciphertext: current.content,
                recipientJid: nextRecipient,
                type: current.attrs.type,
            });
        }
        for (const child of children(current)) {
            visit(child, nextRecipient);
        }
    };
    visit(node);
    return result;
}
function signalKeyPair(pair) {
    return {
        privKey: Buffer.from(pair.private),
        pubKey: pair.public.length === 33
            ? Buffer.from(pair.public)
            : Buffer.concat([KEY_BUNDLE_TYPE, pair.public]),
    };
}
function cloneSignalSession(session) {
    return SessionRecord.deserialize(session.serialize());
}
export function signalBundleIdentityKey(jid) {
    return jid.replace(/:\d+(?=@)/u, "");
}
function signalProtocolAddress(jid) {
    const match = /^(\d{7,15})(?::(\d+))?@(s\.whatsapp\.net|lid)$/iu.exec(jid);
    if (!match) {
        return undefined;
    }
    const deviceId = Number(match[2] ?? "0");
    if (!Number.isSafeInteger(deviceId) || deviceId < 0) {
        return undefined;
    }
    return {
        deviceId,
        name: match[3].toLowerCase() === "lid" ? `${match[1]}_1` : match[1],
    };
}
function unpadRandomMax16(value) {
    const buffer = Buffer.from(value);
    const padding = buffer.at(-1);
    if (!padding || padding > 16 || padding > buffer.length) {
        throw new Error("Invalid WhatsApp message padding.");
    }
    for (let index = buffer.length - padding; index < buffer.length; index += 1) {
        if (buffer[index] !== padding) {
            throw new Error("Invalid WhatsApp message padding.");
        }
    }
    return buffer.subarray(0, buffer.length - padding);
}
function readWhatsAppConversation(message) {
    const fields = readProtobufLengthDelimitedFields(message);
    const conversation = readUtf8(fields.get(1)?.[0]);
    if (conversation?.trim()) {
        return conversation;
    }
    const extendedText = fields.get(6)?.[0];
    const extendedConversation = extendedText
        ? readUtf8(readProtobufLengthDelimitedFields(extendedText).get(1)?.[0])
        : undefined;
    if (extendedConversation?.trim()) {
        return extendedConversation;
    }
    const deviceSentMessage = fields.get(31)?.[0];
    const nestedMessage = deviceSentMessage
        ? readProtobufLengthDelimitedFields(deviceSentMessage).get(2)?.[0]
        : undefined;
    return nestedMessage ? readWhatsAppConversation(nestedMessage) : undefined;
}
function readProtobufLengthDelimitedFields(value) {
    const fields = new Map();
    let offset = 0;
    while (offset < value.length) {
        const tag = readProtobufVarint(value, offset);
        offset = tag.offset;
        const fieldNumber = tag.value >>> 3;
        const wireType = tag.value & 7;
        if (fieldNumber < 1) {
            throw new Error("Invalid WhatsApp protobuf field.");
        }
        if (wireType === 2) {
            const length = readProtobufVarint(value, offset);
            offset = length.offset;
            const end = offset + length.value;
            if (end > value.length) {
                throw new Error("Invalid WhatsApp protobuf length.");
            }
            const entries = fields.get(fieldNumber) ?? [];
            entries.push(value.subarray(offset, end));
            fields.set(fieldNumber, entries);
            offset = end;
            continue;
        }
        if (wireType === 0) {
            offset = readProtobufVarint(value, offset).offset;
            continue;
        }
        if (wireType === 1) {
            offset += 8;
            continue;
        }
        if (wireType === 5) {
            offset += 4;
            continue;
        }
        throw new Error(`Unsupported WhatsApp protobuf wire type: ${wireType}.`);
    }
    return fields;
}
function readProtobufVarint(value, start) {
    let result = 0;
    let shift = 0;
    let offset = start;
    while (offset < value.length && shift <= 28) {
        const byte = value[offset++];
        result += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) {
            if (!Number.isSafeInteger(result)) {
                break;
            }
            return { offset, value: result };
        }
        shift += 7;
    }
    throw new Error("Invalid WhatsApp protobuf varint.");
}
function readUtf8(value) {
    if (!value) {
        return undefined;
    }
    const text = Buffer.from(value).toString("utf8");
    return Buffer.from(text, "utf8").equals(Buffer.from(value)) ? text : undefined;
}
function createInboundMessageNode(message) {
    const from = message.key.remoteJid;
    const attrs = {
        from,
        id: message.key.id,
        notify: message.pushName ?? "Test User",
        t: String(message.messageTimestamp),
    };
    if (isGroupJid(from) && message.key.participant) {
        attrs.participant = message.key.participant;
    }
    return {
        attrs,
        content: [
            {
                attrs: {},
                content: encodePlaintextConversationMessage(message.message.conversation),
                tag: "plaintext",
            },
        ],
        tag: "message",
    };
}
function createIv(counter) {
    const iv = Buffer.alloc(IV_LENGTH);
    iv.writeUInt32BE(counter, 8);
    return iv;
}
function encodeLengthPrefixed(data) {
    const frame = Buffer.allocUnsafe(3 + data.byteLength);
    frame[0] = (data.byteLength >>> 16) & 0xff;
    frame[1] = (data.byteLength >>> 8) & 0xff;
    frame[2] = data.byteLength & 0xff;
    frame.set(data, 3);
    return frame;
}
function firstChild(node) {
    return children(node)[0];
}
function encodePlaintextConversationMessage(text) {
    const textBytes = Buffer.from(text, "utf8");
    return Buffer.from([0x0a, ...encodeVarint(textBytes.byteLength), ...textBytes]);
}
function encodeVarint(value) {
    const bytes = [];
    let remaining = value;
    while (remaining >= 0x80) {
        bytes.push((remaining & 0x7f) | 0x80);
        remaining = Math.floor(remaining / 0x80);
    }
    bytes.push(remaining);
    return bytes;
}
function isGroupJid(jid) {
    return jid.endsWith("@g.us");
}
function requireAttr(node, name) {
    const value = node.attrs[name];
    if (!value) {
        throw new Error(`Baileys node <${node.tag}> requires ${name}.`);
    }
    return value;
}
function lidForJid(jid) {
    const user = jid.split("@", 1)[0]?.split(":", 1)[0] ?? "15550000000";
    return `${user}@lid`;
}
function sanitizeNodeForJson(value) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return { base64: Buffer.from(value).toString("base64"), type: "Buffer" };
    }
    if (Array.isArray(value)) {
        return value.map(sanitizeNodeForJson);
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeNodeForJson(entry)]));
    }
    return value;
}
function unixSeconds() {
    return Math.floor(Date.now() / 1000).toString();
}
