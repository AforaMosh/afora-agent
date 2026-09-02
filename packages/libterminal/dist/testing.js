import "./worker.js";
//#region src/testing.ts
const LIBTERMINAL_EXPORTS = [
	"@afora/libterminal",
	"@afora/libterminal/protocol",
	"@afora/libterminal/stream",
	"@afora/libterminal/browser",
	"@afora/libterminal/node",
	"@afora/libterminal/worker",
	"@afora/libterminal/worker-assets",
	"@afora/libterminal/testing"
];
function createFakeTerminalDuplex() {
	const output = new AsyncByteQueue();
	const writes = [];
	const sizes = [];
	const closeReasons = [];
	return {
		output,
		writes,
		sizes,
		closeReasons,
		write: async (bytes) => {
			writes.push(bytes.slice());
		},
		resize: async (size) => {
			sizes.push({ ...size });
		},
		close: async (reason) => {
			closeReasons.push(reason);
			output.close();
		},
		emitOutput: (bytes) => output.push(bytes),
		endOutput: () => output.close()
	};
}
var FakeWebSocket = class {
	readyState = 1;
	sent = [];
	closed;
	messages = /* @__PURE__ */ new Set();
	closes = /* @__PURE__ */ new Set();
	errors = /* @__PURE__ */ new Set();
	send(data) {
		this.sent.push(data);
	}
	close(code, reason) {
		this.closed = {
			code,
			reason
		};
		this.readyState = 3;
	}
	addEventListener(type, listener) {
		if (type === "message") this.messages.add(listener);
		else if (type === "close") this.closes.add(listener);
		else this.errors.add(listener);
	}
	removeEventListener(type, listener) {
		if (type === "message") this.messages.delete(listener);
		else if (type === "close") this.closes.delete(listener);
		else this.errors.delete(listener);
	}
	receive(data) {
		for (const listener of this.messages) listener({ data });
	}
	emitClose(code = 1e3, reason = "") {
		this.readyState = 3;
		for (const listener of this.closes) listener({
			code,
			reason
		});
	}
	emitError() {
		for (const listener of this.errors) listener();
	}
};
var ManualClock = class {
	currentTime = 0;
	nextId = 1;
	tasks = /* @__PURE__ */ new Map();
	now() {
		return this.currentTime;
	}
	setTimeout(callback, delayMs) {
		const id = this.nextId++;
		this.tasks.set(id, {
			at: this.currentTime + Math.max(0, delayMs),
			callback
		});
		return id;
	}
	clearTimeout(id) {
		this.tasks.delete(id);
	}
	advanceBy(durationMs) {
		if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError("durationMs must be a non-negative finite number");
		const target = this.currentTime + durationMs;
		for (;;) {
			const next = this.nextTask(target);
			if (!next) break;
			this.currentTime = next.at;
			this.tasks.delete(next.id);
			next.callback();
		}
		this.currentTime = target;
	}
	nextTask(target) {
		let selected;
		for (const [id, task] of this.tasks) {
			if (task.at > target || selected && selected.at <= task.at) continue;
			selected = {
				id,
				...task
			};
		}
		return selected;
	}
};
function terminalBytes(value) {
	return new TextEncoder().encode(value);
}
function terminalText(chunks) {
	const collected = [...chunks];
	const byteLength = collected.reduce((total, chunk) => total + chunk.byteLength, 0);
	const joined = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of collected) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(joined);
}
async function collectTerminalOutput(output, limit = Number.POSITIVE_INFINITY) {
	const chunks = [];
	for await (const chunk of output) {
		chunks.push(chunk.slice());
		if (chunks.length >= limit) break;
	}
	return chunks;
}
var AsyncByteQueue = class {
	chunks = [];
	waiters = [];
	closed = false;
	[Symbol.asyncIterator]() {
		return this;
	}
	push(bytes) {
		const waiter = this.waiters.shift();
		if (waiter) waiter({
			done: false,
			value: bytes.slice()
		});
		else if (!this.closed) this.chunks.push(bytes.slice());
	}
	async next() {
		const chunk = this.chunks.shift();
		if (chunk) return {
			done: false,
			value: chunk
		};
		if (this.closed) return {
			done: true,
			value: void 0
		};
		return new Promise((resolve) => this.waiters.push(resolve));
	}
	close() {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter({
			done: true,
			value: void 0
		});
	}
};
//#endregion
export { FakeWebSocket, LIBTERMINAL_EXPORTS, ManualClock, collectTerminalOutput, createFakeTerminalDuplex, terminalBytes, terminalText };
