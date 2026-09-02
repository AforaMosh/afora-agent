import { Buffer } from "node:buffer";
export function decodeHandshakeMessage(data) {
    const reader = new ProtoReader(data);
    const message = {};
    while (!reader.done()) {
        const tag = reader.tag();
        const field = tag >>> 3;
        if (field === 2) {
            requireBytesWireType(tag, field);
            message.clientHello = decodeClientHello(reader.bytes());
        }
        else if (field === 4) {
            requireBytesWireType(tag, field);
            message.clientFinish = decodeClientFinish(reader.bytes());
        }
        else {
            reader.skip(tag & 7);
        }
    }
    return message;
}
export function encodeHandshakeMessage(message) {
    const writer = new ProtoWriter();
    if (message.serverHello) {
        writer.bytesField(3, encodeServerHello(message.serverHello));
    }
    return writer.finish();
}
function decodeClientHello(data) {
    const reader = new ProtoReader(data);
    let ephemeral;
    while (!reader.done()) {
        const tag = reader.tag();
        if (tag >>> 3 === 1) {
            requireBytesWireType(tag, 1);
            ephemeral = reader.bytes();
        }
        else {
            reader.skip(tag & 7);
        }
    }
    return ephemeral === undefined ? {} : { ephemeral };
}
function decodeClientFinish(data) {
    const reader = new ProtoReader(data);
    let payload;
    let staticKey;
    while (!reader.done()) {
        const tag = reader.tag();
        const field = tag >>> 3;
        if (field === 1) {
            requireBytesWireType(tag, field);
            staticKey = reader.bytes();
        }
        else if (field === 2) {
            requireBytesWireType(tag, field);
            payload = reader.bytes();
        }
        else {
            reader.skip(tag & 7);
        }
    }
    return {
        ...(payload === undefined ? {} : { payload }),
        ...(staticKey === undefined ? {} : { staticKey }),
    };
}
function requireBytesWireType(tag, field) {
    const wireType = tag & 7;
    if (wireType !== 2) {
        throw new Error(`Invalid WhatsApp handshake wire type ${wireType} for length-delimited field ${field}.`);
    }
}
function encodeServerHello(serverHello) {
    const writer = new ProtoWriter();
    writer.bytesField(1, serverHello.ephemeral);
    writer.bytesField(2, serverHello.staticKey);
    writer.bytesField(3, serverHello.payload);
    return writer.finish();
}
class ProtoReader {
    #offset = 0;
    #buffer;
    constructor(data) {
        this.#buffer = Buffer.from(data);
    }
    done() {
        return this.#offset >= this.#buffer.length;
    }
    bytes() {
        const length = this.uint32();
        this.#require(length);
        const value = this.#buffer.subarray(this.#offset, this.#offset + length);
        this.#offset += length;
        return value;
    }
    skip(wireType) {
        if (wireType === 0) {
            this.#skipVarint();
            return;
        }
        if (wireType === 1) {
            this.#require(8);
            this.#offset += 8;
            return;
        }
        if (wireType === 2) {
            const length = this.uint32();
            this.#require(length);
            this.#offset += length;
            return;
        }
        if (wireType === 5) {
            this.#require(4);
            this.#offset += 4;
            return;
        }
        throw new Error(`Unsupported WhatsApp handshake wire type: ${wireType}.`);
    }
    tag() {
        const tag = this.uint32();
        if (tag >>> 3 === 0) {
            throw new Error("Invalid WhatsApp handshake protobuf field number 0.");
        }
        return tag;
    }
    uint32() {
        let value = 0;
        let shift = 0;
        while (shift < 32) {
            this.#require(1);
            const byte = this.#buffer[this.#offset];
            this.#offset += 1;
            if (byte === undefined) {
                throw new Error("Unexpected end of WhatsApp handshake protobuf.");
            }
            if (shift === 28 && byte > 0x0f) {
                throw new Error("Invalid WhatsApp handshake varint.");
            }
            value |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) {
                return value >>> 0;
            }
            shift += 7;
        }
        throw new Error("Invalid WhatsApp handshake varint.");
    }
    #skipVarint() {
        for (let index = 0; index < 10; index += 1) {
            this.#require(1);
            const byte = this.#buffer[this.#offset];
            this.#offset += 1;
            if (byte === undefined || (index === 9 && byte > 1)) {
                throw new Error("Invalid WhatsApp handshake varint.");
            }
            if ((byte & 0x80) === 0) {
                return;
            }
        }
        throw new Error("Invalid WhatsApp handshake varint.");
    }
    #require(length) {
        if (this.#offset + length > this.#buffer.length) {
            throw new Error("Unexpected end of WhatsApp handshake protobuf.");
        }
    }
}
class ProtoWriter {
    #parts = [];
    bytesField(field, value) {
        this.uint32((field << 3) | 2);
        this.uint32(value.byteLength);
        this.#parts.push(Buffer.from(value));
    }
    finish() {
        return Buffer.concat(this.#parts);
    }
    uint32(value) {
        let remaining = value >>> 0;
        const bytes = [];
        while (remaining > 127) {
            bytes.push((remaining & 0x7f) | 0x80);
            remaining >>>= 7;
        }
        bytes.push(remaining);
        this.#parts.push(Buffer.from(bytes));
    }
}
