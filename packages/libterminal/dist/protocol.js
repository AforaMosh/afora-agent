import { LibterminalError, assertTerminalSize } from "./index.js";
//#region src/protocol.ts
const TERMINAL_WS_MAGIC = 22851;
const TERMINAL_WS_VERSION = 2;
const DEFAULT_MAX_TERMINAL_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_SESSION_ID_BYTES = 4096;
const TerminalMessageType = {
	Hello: 1,
	Welcome: 2,
	Subscribe: 10,
	Unsubscribe: 11,
	Output: 20,
	Snapshot: 21,
	Event: 22,
	Error: 23,
	Input: 30,
	Key: 31,
	Resize: 32,
	Stop: 33,
	ControlRequest: 50,
	ControlDecision: 51,
	ControlGranted: 52,
	ControlRevoked: 53,
	Ping: 60,
	Pong: 61,
	Ack: 62
};
const TerminalSubscribeFlags = {
	Output: 1,
	Snapshot: 2,
	Events: 4,
	OutputAcknowledgements: 8
};
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const terminalMessageTypes = new Set(Object.values(TerminalMessageType));
function encodeTerminalFrame(params, limits) {
	const sessionId = params.sessionId ?? "";
	const sessionIdBytes = textEncoder.encode(sessionId);
	const payload = params.payload ?? /* @__PURE__ */ new Uint8Array();
	const maxSessionIdBytes = limits?.maxSessionIdBytes ?? 4096;
	const maxFrameBytes = limits?.maxFrameBytes ?? 1048576;
	if (sessionIdBytes.byteLength > maxSessionIdBytes) throw invalidFrame(`session id exceeds ${maxSessionIdBytes} bytes`);
	if (!isTerminalMessageType(params.type)) throw invalidFrame(`terminal frame message type ${String(params.type)} is unsupported`);
	const frameLength = 8 + sessionIdBytes.length + 4 + payload.length;
	if (frameLength > maxFrameBytes) throw invalidFrame(`terminal frame exceeds ${maxFrameBytes} bytes`);
	const frame = new Uint8Array(frameLength);
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	let offset = 0;
	view.setUint16(offset, TERMINAL_WS_MAGIC, true);
	offset += 2;
	view.setUint8(offset, 2);
	offset += 1;
	view.setUint8(offset, params.type);
	offset += 1;
	view.setUint32(offset, sessionIdBytes.length, true);
	offset += 4;
	frame.set(sessionIdBytes, offset);
	offset += sessionIdBytes.length;
	view.setUint32(offset, payload.length, true);
	offset += 4;
	frame.set(payload, offset);
	return frame;
}
function decodeTerminalFrame(data, limits) {
	const maxFrameBytes = limits?.maxFrameBytes ?? 1048576;
	const maxSessionIdBytes = limits?.maxSessionIdBytes ?? 4096;
	if (data.byteLength > maxFrameBytes) throw invalidFrame(`terminal frame exceeds ${maxFrameBytes} bytes`);
	if (data.byteLength < 12) throw invalidFrame("terminal frame is shorter than its fixed header");
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let offset = 0;
	if (view.getUint16(offset, true) !== 22851) throw invalidFrame("terminal frame has invalid magic");
	offset += 2;
	const version = view.getUint8(offset);
	if (version !== 2) throw new LibterminalError("unsupported_protocol", `terminal protocol version ${version} is unsupported`);
	offset += 1;
	const type = view.getUint8(offset);
	if (!isTerminalMessageType(type)) throw invalidFrame(`terminal frame message type ${type} is unsupported`);
	offset += 1;
	const sessionIdLength = view.getUint32(offset, true);
	offset += 4;
	if (sessionIdLength > maxSessionIdBytes) throw invalidFrame(`session id exceeds ${maxSessionIdBytes} bytes`);
	if (offset + sessionIdLength + 4 > data.byteLength) throw invalidFrame("terminal frame session id length exceeds frame length");
	let sessionId;
	try {
		sessionId = textDecoder.decode(data.subarray(offset, offset + sessionIdLength));
	} catch (cause) {
		throw new LibterminalError("invalid_frame", "terminal frame session id is not UTF-8", { cause });
	}
	offset += sessionIdLength;
	const payloadLength = view.getUint32(offset, true);
	offset += 4;
	if (offset + payloadLength !== data.byteLength) throw invalidFrame("terminal frame payload length does not match frame length");
	return {
		type,
		sessionId,
		payload: data.subarray(offset, offset + payloadLength)
	};
}
function tryDecodeTerminalFrame(data, limits) {
	try {
		return decodeTerminalFrame(data, limits);
	} catch {
		return null;
	}
}
function encodeSubscribePayload(params) {
	assertSubscribeSize({
		columns: params.columns,
		rows: params.rows
	});
	const flags = assertUint32(params.flags, "terminal subscribe flags");
	const snapshotMinIntervalMs = assertUint32(params.snapshotMinIntervalMs ?? 0, "terminal subscribe minimum snapshot interval");
	const snapshotMaxIntervalMs = assertUint32(params.snapshotMaxIntervalMs ?? 0, "terminal subscribe maximum snapshot interval");
	const payload = /* @__PURE__ */ new Uint8Array(20);
	const view = new DataView(payload.buffer);
	view.setUint32(0, flags, true);
	view.setUint32(4, snapshotMinIntervalMs, true);
	view.setUint32(8, snapshotMaxIntervalMs, true);
	view.setUint32(12, params.columns, true);
	view.setUint32(16, params.rows, true);
	return payload;
}
function decodeSubscribePayload(payload) {
	if (payload.byteLength !== 20) throw invalidFrame("terminal subscribe payload must be exactly 20 bytes");
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const decoded = {
		flags: view.getUint32(0, true),
		snapshotMinIntervalMs: view.getUint32(4, true),
		snapshotMaxIntervalMs: view.getUint32(8, true),
		columns: view.getUint32(12, true),
		rows: view.getUint32(16, true)
	};
	assertSubscribeSize(decoded);
	return decoded;
}
function encodeResizePayload(size) {
	assertTerminalSize(size);
	const payload = /* @__PURE__ */ new Uint8Array(8);
	const view = new DataView(payload.buffer);
	view.setUint32(0, size.columns >>> 0, true);
	view.setUint32(4, size.rows >>> 0, true);
	return payload;
}
function decodeResizePayload(payload) {
	if (payload.byteLength !== 8) throw invalidFrame("terminal resize payload must be exactly 8 bytes");
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	return assertTerminalSize({
		columns: view.getUint32(0, true),
		rows: view.getUint32(4, true)
	});
}
function encodeAckPayload(bytes) {
	assertUint32(bytes, "terminal acknowledgement");
	const payload = /* @__PURE__ */ new Uint8Array(4);
	new DataView(payload.buffer).setUint32(0, bytes, true);
	return payload;
}
function decodeAckPayload(payload) {
	if (payload.byteLength !== 4) throw invalidFrame("terminal acknowledgement payload must be exactly 4 bytes");
	return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
}
function encodeJsonPayload(value) {
	let json;
	try {
		json = JSON.stringify(value);
	} catch (cause) {
		throw new LibterminalError("invalid_frame", "terminal JSON payload is not serializable", { cause });
	}
	if (json === void 0) throw invalidFrame("terminal JSON payload is not serializable");
	return textEncoder.encode(json);
}
function decodeJsonPayload(payload) {
	try {
		return JSON.parse(textDecoder.decode(payload));
	} catch (cause) {
		throw new LibterminalError("invalid_frame", "terminal JSON payload is invalid", { cause });
	}
}
function invalidFrame(message) {
	return new LibterminalError("invalid_frame", message);
}
function assertUint32(value, label) {
	if (!Number.isSafeInteger(value) || value < 0 || value > 4294967295) throw invalidFrame(`${label} must be an unsigned 32-bit integer`);
	return value;
}
function assertSubscribeSize(size) {
	if (size.columns === 0 && size.rows === 0) return size;
	return assertTerminalSize(size);
}
function isTerminalMessageType(value) {
	return terminalMessageTypes.has(value);
}
//#endregion
export { DEFAULT_MAX_SESSION_ID_BYTES, DEFAULT_MAX_TERMINAL_FRAME_BYTES, TERMINAL_WS_MAGIC, TERMINAL_WS_VERSION, TerminalMessageType, TerminalSubscribeFlags, decodeAckPayload, decodeJsonPayload, decodeResizePayload, decodeSubscribePayload, decodeTerminalFrame, encodeAckPayload, encodeJsonPayload, encodeResizePayload, encodeSubscribePayload, encodeTerminalFrame, tryDecodeTerminalFrame };
