import { LibterminalError } from "./index.js";
//#region src/worker.ts
const WEB_SOCKET_CONNECTING = 0;
const WEB_SOCKET_OPEN = 1;
const encoder = new TextEncoder();
function bridgeWebSockets(left, right, options = {}) {
	const deniedReason = options.deniedReason ?? "terminal control revoked";
	const controlCheckIntervalMs = options.controlCheckIntervalMs ?? 5e3;
	let leftInputQueue = Promise.resolve();
	let rightOutputQueue = Promise.resolve();
	let controlTimer;
	let controlCheckInFlight;
	let leftCanSend = true;
	let outstandingRightBytes = 0;
	let stopped = false;
	let resolveCompleted = noop;
	const completed = new Promise((resolve) => {
		resolveCompleted = resolve;
	});
	const reportError = (error) => {
		try {
			options.onError?.(error);
		} catch {}
	};
	const sanitizeReason = (value) => {
		const source = typeof value === "string" ? value : "";
		try {
			return cleanReason(options.sanitizeCloseReason?.(source) ?? source);
		} catch (error) {
			reportError(error);
			return "";
		}
	};
	const stop = () => {
		if (stopped) return;
		stopped = true;
		if (controlTimer) {
			clearInterval(controlTimer);
			controlTimer = void 0;
		}
		left.removeEventListener("message", onLeftMessage);
		right.removeEventListener("message", onRightMessage);
		left.removeEventListener("close", onLeftClose);
		right.removeEventListener("close", onRightClose);
		left.removeEventListener("error", onLeftError);
		right.removeEventListener("error", onRightError);
		Promise.allSettled([leftInputQueue, rightOutputQueue]).then(() => resolveCompleted());
	};
	const close = (code = 1e3, reason = "bridge closed") => {
		closePair(left, right, code, sanitizeReason(reason));
		stop();
	};
	const fail = (error) => {
		reportError(error);
		close(1011, "terminal bridge error");
	};
	const verifyControl = async () => {
		if (!options.canSendLeft) return true;
		let canSend = false;
		try {
			canSend = await options.canSendLeft();
		} catch (error) {
			reportError(error);
		}
		leftCanSend = canSend;
		if (!canSend) close(1008, deniedReason);
		return canSend;
	};
	const revalidateControl = async () => {
		if (stopped) return false;
		try {
			options.reconcileSubscription?.();
			controlCheckInFlight ??= verifyControl().finally(() => {
				controlCheckInFlight = void 0;
			});
			return await controlCheckInFlight;
		} catch (error) {
			fail(error);
			return false;
		}
	};
	function onLeftMessage(event) {
		leftInputQueue = leftInputQueue.then(async () => {
			if (!pairIsOpen(left, right)) return;
			if (!leftCanSend || !await revalidateControl()) return;
			const forwarded = await normalizeWebSocketMessageData(event.data);
			const acknowledgedBytes = options.forwardRightOutputAcknowledgements ? decodeOutputAcknowledgement(forwarded) : null;
			if (acknowledgedBytes !== null) {
				if (acknowledgedBytes <= outstandingRightBytes) {
					outstandingRightBytes -= acknowledgedBytes;
					sendOutputAcknowledgement(right, acknowledgedBytes);
				}
				return;
			}
			right.send(forwarded);
		}).catch(fail);
	}
	function onRightMessage(event) {
		rightOutputQueue = rightOutputQueue.then(async () => {
			if (!pairIsOpen(left, right)) return;
			const forwarded = await normalizeWebSocketMessageData(event.data);
			left.send(forwarded);
			if (options.forwardRightOutputAcknowledgements) outstandingRightBytes += terminalMessageByteLength(forwarded);
			else if (options.acknowledgeRightOutputImmediately) sendOutputAcknowledgement(right, terminalMessageByteLength(forwarded));
		}).catch(fail);
	}
	function onLeftClose(event) {
		closePeer(event, right, sanitizeReason);
		stop();
	}
	function onRightClose(event) {
		closePeer(event, left, sanitizeReason);
		stop();
	}
	function onLeftError() {
		fail(new LibterminalError("transport_closed", "left WebSocket failed"));
	}
	function onRightError() {
		fail(new LibterminalError("transport_closed", "right WebSocket failed"));
	}
	left.addEventListener("message", onLeftMessage);
	right.addEventListener("message", onRightMessage);
	left.addEventListener("close", onLeftClose);
	right.addEventListener("close", onRightClose);
	left.addEventListener("error", onLeftError);
	right.addEventListener("error", onRightError);
	if (options.canSendLeft) {
		revalidateControl();
		if (controlCheckIntervalMs > 0) controlTimer = setInterval(() => void revalidateControl(), controlCheckIntervalMs);
	}
	return {
		completed,
		get rightOutputAcknowledgementBytes() {
			return outstandingRightBytes;
		},
		revalidateControl,
		close
	};
}
function terminalOutputAcknowledgements(value) {
	try {
		return new URL(value).searchParams.get("flow") === "ack-v1";
	} catch {
		return false;
	}
}
function decodeOutputAcknowledgement(value) {
	if (typeof value !== "string" || !value.startsWith("{") || value.length > 100) return null;
	try {
		const parsed = JSON.parse(value);
		if (!isRecord(parsed)) return null;
		const bytes = parsed.bytes;
		return parsed.type === "ack" && Number.isInteger(bytes) && Number(bytes) > 0 && Number(bytes) <= 1024 * 1024 ? Number(bytes) : null;
	} catch {
		return null;
	}
}
function terminalMessageByteLength(value) {
	return typeof value === "string" ? encoder.encode(value).byteLength : value.byteLength;
}
function sendOutputAcknowledgement(socket, bytes) {
	if (bytes > 0 && socket.readyState === 1) socket.send(JSON.stringify({
		type: "ack",
		bytes
	}));
}
async function normalizeWebSocketMessageData(data) {
	if (typeof data === "string" || data instanceof ArrayBuffer) return data;
	if (ArrayBuffer.isView(data)) {
		const copied = new Uint8Array(data.byteLength);
		copied.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
		return copied.buffer;
	}
	if (typeof Blob !== "undefined" && data instanceof Blob) return data.arrayBuffer();
	if (hasArrayBuffer(data)) return data.arrayBuffer();
	return String(data);
}
function pairIsOpen(left, right) {
	return left.readyState === 1 && right.readyState === 1;
}
function closePeer(event, peer, sanitizeReason) {
	if (canClose(peer)) safeClose(peer, event.code || 1e3, sanitizeReason(event.reason || "peer closed"));
}
function closePair(left, right, code, reason) {
	if (canClose(left)) safeClose(left, code, reason);
	if (canClose(right)) safeClose(right, code, reason);
}
function canClose(socket) {
	return socket.readyState === 1 || socket.readyState === 0;
}
function cleanReason(value) {
	const source = (typeof value === "string" ? value : "").trim();
	let result = "";
	let bytes = 0;
	for (const character of source) {
		const characterBytes = encoder.encode(character).byteLength;
		if (bytes + characterBytes > 123) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}
function safeClose(socket, code, reason) {
	const safeCode = validCloseCode(code) ? code : 1e3;
	const safeReason = cleanReason(reason);
	try {
		socket.close(safeCode, safeReason);
	} catch {
		try {
			socket.close(1e3, safeReason);
		} catch {
			try {
				socket.close();
			} catch {}
		}
	}
}
function validCloseCode(code) {
	return code === 1e3 || code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
}
function hasArrayBuffer(value) {
	return value !== null && typeof value === "object" && "arrayBuffer" in value && typeof value.arrayBuffer === "function";
}
function isRecord(value) {
	return value !== null && typeof value === "object";
}
function noop() {}
//#endregion
export { WEB_SOCKET_CONNECTING, WEB_SOCKET_OPEN, bridgeWebSockets, decodeOutputAcknowledgement, normalizeWebSocketMessageData, sendOutputAcknowledgement, terminalMessageByteLength, terminalOutputAcknowledgements };
