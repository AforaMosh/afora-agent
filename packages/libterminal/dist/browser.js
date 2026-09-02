import { LibterminalError, assertTerminalSize } from "./index.js";
import { TerminalMessageType, encodeTerminalFrame, tryDecodeTerminalFrame } from "./protocol.js";
//#region src/browser-color-query.ts
const ESC = "\x1B";
const BEL = "\x07";
const CAN = "";
const SUB = "";
const ST = `${ESC}\\`;
const MAX_PENDING_COLOR_SEQUENCE_CHARS = 1024;
const DYNAMIC_COLOR_SLOTS = [
	{
		color: "foreground",
		slot: 10
	},
	{
		color: "background",
		slot: 11
	},
	{
		color: "cursor",
		slot: 12
	}
];
const DYNAMIC_COLOR_HEADERS = DYNAMIC_COLOR_SLOTS.map(({ slot }) => ({
	sequence: `${ESC}]${slot};`,
	slot
}));
function findOscBoundary(data, start) {
	for (let index = start; index < data.length; index += 1) {
		if (data[index] === BEL) return {
			kind: "terminator",
			index,
			terminator: BEL
		};
		if (data[index] === CAN || data[index] === SUB) return {
			kind: "cancel",
			index
		};
		if (data[index] === ESC && data[index + 1] === "\\") return {
			kind: "terminator",
			index,
			terminator: ST
		};
		if (data[index] === ESC && data[index + 1] === "]") return {
			kind: "restart",
			index
		};
	}
	return null;
}
function formatOscColor(slot, color, terminator) {
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(color);
	if (!match) return null;
	const [, red, green, blue] = match;
	return `${ESC}]${slot};rgb:${red}${red}/${green}${green}/${blue}${blue}${terminator}`;
}
/**
* Answers streamed OSC 10-12 dynamic-color queries for browser terminals whose
* emulator does not emit those replies. Color values must use `#rrggbb` syntax.
*/
function createTerminalDefaultColorQueryResponder(options) {
	let pending = "";
	let flushingReplies = false;
	const replies = [];
	const flushReplies = () => {
		if (flushingReplies) return;
		flushingReplies = true;
		let sent = 0;
		try {
			while (sent < replies.length) {
				options.reply(replies[sent]);
				sent += 1;
			}
		} finally {
			replies.splice(0, sent);
			flushingReplies = false;
		}
	};
	const process = (data, shouldReply) => {
		pending += data;
		while (pending.length > 0) {
			const queryStart = pending.indexOf(`${ESC}]`);
			if (queryStart === -1) {
				pending = pending.endsWith(ESC) ? ESC : "";
				break;
			}
			if (queryStart > 0) pending = pending.slice(queryStart);
			const header = DYNAMIC_COLOR_HEADERS.find(({ sequence }) => pending.startsWith(sequence));
			if (!header) {
				if (DYNAMIC_COLOR_HEADERS.some(({ sequence }) => sequence.startsWith(pending))) break;
				pending = pending.slice(1);
				continue;
			}
			const boundary = findOscBoundary(pending, header.sequence.length);
			if (!boundary) {
				if (pending.length <= MAX_PENDING_COLOR_SEQUENCE_CHARS) break;
				pending = pending.slice(1);
				continue;
			}
			if (boundary.kind === "restart") {
				pending = pending.slice(boundary.index);
				continue;
			}
			if (boundary.kind === "cancel") {
				pending = pending.slice(boundary.index + 1);
				continue;
			}
			if (shouldReply) {
				const colors = options.getColors();
				let slot = header.slot;
				const payload = pending.slice(header.sequence.length, boundary.index);
				for (const value of payload.split(";")) {
					if (value) {
						const target = DYNAMIC_COLOR_SLOTS.find((entry) => entry.slot === slot);
						if (value === "?" && target) {
							const response = formatOscColor(slot, colors[target.color], boundary.terminator);
							if (response) replies.push(response);
						}
					}
					slot += 1;
				}
			}
			pending = pending.slice(boundary.index + boundary.terminator.length);
		}
		if (shouldReply) flushReplies();
	};
	return {
		observe(data) {
			process(data, true);
		},
		primeFromReplay(data) {
			pending = "";
			process(data, false);
		}
	};
}
//#endregion
//#region src/browser.ts
const textEncoder = new TextEncoder();
const runtimeCache = /* @__PURE__ */ new Map();
const WEB_SOCKET_CLOSING = 2;
const WEB_SOCKET_OPEN = 1;
async function loadGhosttyRuntime(options) {
	if (options?.module) return loadRuntimeFromModule(options.module, options.wasmUrl);
	const cacheKey = options?.wasmUrl ?? "<default>";
	let runtime = runtimeCache.get(cacheKey);
	if (!runtime) {
		runtime = import("ghostty-web").then((module) => loadRuntimeFromModule(module, options?.wasmUrl));
		runtimeCache.set(cacheKey, runtime);
	}
	try {
		return await runtime;
	} catch (cause) {
		runtimeCache.delete(cacheKey);
		throw new LibterminalError("ghostty_unavailable", "failed to load Ghostty browser runtime", { cause });
	}
}
async function createGhosttyTerminal(options) {
	options.onStatus?.({ state: "loading" });
	throwIfAborted(options.signal);
	let terminal;
	let controller;
	try {
		const runtime = options.runtime ?? await loadGhosttyRuntime(options.runtimeOptions);
		throwIfAborted(options.signal);
		const readOnly = options.readOnly ?? true;
		terminal = new runtime.Terminal({
			...options.terminalOptions,
			disableStdin: readOnly,
			ghostty: runtime.ghostty
		});
		const fitAddon = new runtime.FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(options.parent);
		controller = new BrowserTerminalController(terminal, fitAddon, readOnly, options);
		controller.start();
		options.onStatus?.({ state: "ready" });
		return controller;
	} catch (cause) {
		if (controller) controller.dispose();
		else terminal?.dispose();
		if (isAbortReason(options.signal, cause)) throw cause;
		options.onStatus?.({
			state: "error",
			error: cause
		});
		if (cause instanceof LibterminalError) throw cause;
		throw new LibterminalError("ghostty_unavailable", "failed to create Ghostty browser terminal", { cause });
	}
}
async function attachTerminalStream(target, source, signal) {
	const iterator = source[Symbol.asyncIterator]();
	const aborted = abortPromise(signal);
	let completed = false;
	let failed = false;
	let failure;
	try {
		for (;;) {
			const result = aborted ? await Promise.race([iterator.next(), aborted.promise]) : await iterator.next();
			if (result === abortedResult || result.done) {
				completed = result !== abortedResult;
				return;
			}
			target.write(result.value);
		}
	} catch (error) {
		failed = true;
		failure = error;
	} finally {
		aborted?.dispose();
		if (!completed) {
			const returned = iterator.return?.();
			if (signal?.aborted) Promise.resolve(returned).catch(noop);
			else try {
				await returned;
			} catch (error) {
				if (!failed) {
					failed = true;
					failure = error;
				}
			}
		}
	}
	if (failed) throw failure;
}
var TerminalHubClient = class {
	options;
	socket;
	reconnectTimer;
	closedByCaller = false;
	constructor(options) {
		this.options = options;
	}
	get isOpen() {
		return this.socket?.readyState === WEB_SOCKET_OPEN;
	}
	connect() {
		this.closedByCaller = false;
		if (this.socket && this.socket.readyState < WEB_SOCKET_CLOSING) return;
		this.clearReconnectTimer();
		let socket;
		try {
			socket = (this.options.socketFactory ?? defaultTerminalHubSocketFactory)(this.resolveUrl());
		} catch (error) {
			this.reportError(error);
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;
		let messageQueue = Promise.resolve();
		const enqueueMessage = (task) => {
			messageQueue = messageQueue.catch(noop).then(task).catch((error) => this.reportError(error));
		};
		socket.binaryType = "arraybuffer";
		socket.addEventListener("open", this.handleOpen(socket));
		socket.addEventListener("message", this.handleMessage(socket, enqueueMessage));
		socket.addEventListener("close", this.handleClose(socket));
		socket.addEventListener("error", this.handleError(socket));
	}
	send(params) {
		const socket = this.socket;
		if (!socket || socket.readyState !== WEB_SOCKET_OPEN) return false;
		try {
			socket.send(encodeTerminalFrame(params, this.options.frameLimits));
			return true;
		} catch (error) {
			this.reportError(error);
			return false;
		}
	}
	close(code = 1e3, reason = "terminal hub closed") {
		this.closedByCaller = true;
		this.clearReconnectTimer();
		const socket = this.socket;
		if (!socket || socket.readyState >= WEB_SOCKET_CLOSING) return;
		try {
			socket.close(code, reason);
		} catch (error) {
			this.socket = void 0;
			this.reportError(error);
		}
	}
	handleOpen(socket) {
		return () => {
			if (this.socket !== socket) return;
			this.send({ type: TerminalMessageType.Hello });
			this.notify(() => this.options.onOpen?.());
		};
	}
	handleMessage(socket, enqueueMessage) {
		return (event) => {
			enqueueMessage(async () => {
				if (this.socket !== socket) return;
				const frame = tryDecodeTerminalFrame(await terminalFrameBytes(event.data), this.options.frameLimits);
				if (frame && this.socket === socket) this.notify(() => this.options.onFrame?.(frame));
			});
		};
	}
	handleClose(socket) {
		return (event) => {
			if (this.socket !== socket) return;
			this.socket = void 0;
			this.notify(() => this.options.onClose?.(event));
			this.scheduleReconnect();
		};
	}
	handleError(socket) {
		return () => {
			if (this.socket === socket) this.reportError();
		};
	}
	resolveUrl() {
		return typeof this.options.url === "function" ? this.options.url() : this.options.url;
	}
	scheduleReconnect() {
		if (this.closedByCaller || this.reconnectTimer || !this.shouldReconnect()) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = void 0;
			this.connect();
		}, this.options.reconnectDelayMs ?? 1500);
	}
	shouldReconnect() {
		try {
			return Boolean(this.options.shouldReconnect?.());
		} catch (error) {
			this.reportError(error);
			return false;
		}
	}
	clearReconnectTimer() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = void 0;
		}
	}
	notify(callback) {
		try {
			callback();
		} catch (error) {
			this.reportError(error);
		}
	}
	reportError(error) {
		try {
			this.options.onError?.(error);
		} catch {}
	}
};
var BrowserTerminalController = class {
	terminal;
	fitAddon;
	options;
	inputSubscription;
	resizeSubscription;
	abortListener;
	disposed = false;
	currentReadOnly;
	disposeController = new AbortController();
	constructor(terminal, fitAddon, readOnly, options) {
		this.terminal = terminal;
		this.fitAddon = fitAddon;
		this.currentReadOnly = readOnly;
		this.options = options;
	}
	get readOnly() {
		return this.currentReadOnly;
	}
	start() {
		this.inputSubscription = this.terminal.onData((data) => {
			if (!this.currentReadOnly) this.options.onData?.(textEncoder.encode(data));
		});
		this.resizeSubscription = this.terminal.onResize(({ cols, rows }) => {
			this.options.onResize?.({
				columns: cols,
				rows
			});
		});
		if (this.options.size) this.resize(this.options.size);
		else if (this.options.autoFit !== false) this.fitAddon.fit();
		if (this.options.autoFit !== false) this.fitAddon.observeResize();
		const signal = this.options.signal;
		if (signal) {
			this.abortListener = () => this.dispose();
			signal.addEventListener("abort", this.abortListener, { once: true });
			if (signal.aborted) this.abortListener();
		}
	}
	write(bytes) {
		this.assertOpen();
		this.terminal.write(bytes);
	}
	resize(size) {
		this.assertOpen();
		assertTerminalSize(size);
		this.terminal.resize(size.columns, size.rows);
	}
	fit() {
		this.assertOpen();
		this.fitAddon.fit();
	}
	setReadOnly(readOnly) {
		this.assertOpen();
		this.currentReadOnly = readOnly;
		this.terminal.options.disableStdin = readOnly;
	}
	async attach(source, signal) {
		this.assertOpen();
		const combined = combineAbortSignals(this.disposeController.signal, signal ?? this.options.signal);
		try {
			await attachTerminalStream(this.terminal, source, combined.signal);
			this.options.onStatus?.({ state: "ended" });
		} catch (error) {
			this.options.onStatus?.({
				state: "error",
				error
			});
			throw error;
		} finally {
			combined.dispose();
		}
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.disposeController.abort("terminal disposed");
		if (this.abortListener) {
			this.options.signal?.removeEventListener("abort", this.abortListener);
			this.abortListener = void 0;
		}
		this.inputSubscription?.dispose();
		this.resizeSubscription?.dispose();
		this.fitAddon.dispose();
		this.terminal.dispose();
	}
	assertOpen() {
		if (this.disposed) throw new LibterminalError("transport_closed", "Ghostty browser terminal is disposed");
	}
};
function defaultTerminalHubSocketFactory(url) {
	return new WebSocket(url);
}
async function terminalFrameBytes(data) {
	if (data instanceof Uint8Array) return data.slice();
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
	if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
	if (hasArrayBuffer(data)) return new Uint8Array(await data.arrayBuffer());
	return textEncoder.encode(String(data));
}
async function loadRuntimeFromModule(module, wasmUrl) {
	try {
		return {
			ghostty: await module.Ghostty.load(wasmUrl),
			Terminal: module.Terminal,
			FitAddon: module.FitAddon
		};
	} catch (cause) {
		throw new LibterminalError("ghostty_unavailable", "failed to load Ghostty WASM", { cause });
	}
}
const abortedResult = Symbol("aborted");
function abortPromise(signal) {
	if (!signal) return;
	if (signal.aborted) return {
		promise: Promise.resolve(abortedResult),
		dispose: () => void 0
	};
	let resolveAbort = noop;
	const promise = new Promise((resolve) => {
		resolveAbort = resolve;
	});
	const abort = () => resolveAbort(abortedResult);
	signal.addEventListener("abort", abort, { once: true });
	return {
		promise,
		dispose: () => signal.removeEventListener("abort", abort)
	};
}
function throwIfAborted(signal) {
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
function isAbortReason(signal, cause) {
	if (!signal?.aborted) return false;
	if (cause === signal.reason) return true;
	return signal.reason === void 0 && cause instanceof DOMException && cause.name === "AbortError";
}
function combineAbortSignals(first, second) {
	if (!second) return {
		signal: first,
		dispose: () => void 0
	};
	const controller = new AbortController();
	const abortFirst = () => controller.abort(first.reason);
	const abortSecond = () => controller.abort(second.reason);
	if (first.aborted) abortFirst();
	else if (second.aborted) abortSecond();
	else {
		first.addEventListener("abort", abortFirst, { once: true });
		second.addEventListener("abort", abortSecond, { once: true });
	}
	return {
		signal: controller.signal,
		dispose: () => {
			first.removeEventListener("abort", abortFirst);
			second.removeEventListener("abort", abortSecond);
		}
	};
}
function noop() {}
function hasArrayBuffer(value) {
	return value !== null && typeof value === "object" && "arrayBuffer" in value && typeof value.arrayBuffer === "function";
}
//#endregion
export { TerminalHubClient, attachTerminalStream, createGhosttyTerminal, createTerminalDefaultColorQueryResponder, loadGhosttyRuntime };
