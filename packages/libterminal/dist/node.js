import { LibterminalError, assertTerminalSize } from "./index.js";
import { t as GHOSTTY_ASSET_PATHS } from "./ghostty-assets-DrsOTGk7.js";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
//#region src/node.ts
const textEncoder = new TextEncoder();
async function loadNodePtyDriver() {
	await ensureNodePtySpawnHelperExecutable();
	try {
		const module = await import("node-pty");
		return { spawn: (command, args, options) => module.spawn(command, args, {
			name: options.name,
			cols: options.columns,
			rows: options.rows,
			cwd: options.cwd,
			env: options.env
		}) };
	} catch (cause) {
		throw new LibterminalError("pty_unavailable", "node-pty is unavailable", { cause });
	}
}
async function spawnLocalPty(options) {
	throwIfAborted(options.signal);
	const size = assertTerminalSize(options.size ?? {
		columns: 120,
		rows: 34
	});
	const output = new AsyncByteQueue(options.outputBufferBytes, options.onOutputDrop);
	const driver = options.driver ?? await loadNodePtyDriver();
	throwIfAborted(options.signal);
	const inputDecoder = new TextDecoder();
	const terminal = driver.spawn(options.command, options.args ?? [], {
		name: options.name ?? process.env.TERM ?? "xterm-256color",
		columns: size.columns,
		rows: size.rows,
		cwd: options.cwd,
		env: options.env ?? currentEnvironment()
	});
	let inputClosed = false;
	const flushInput = () => {
		if (inputClosed) return;
		inputClosed = true;
		const decoded = inputDecoder.decode();
		if (decoded) terminal.write(decoded);
	};
	const kill = (signal) => {
		try {
			flushInput();
		} finally {
			terminal.kill(signal);
		}
	};
	const dataSubscription = terminal.onData((data) => {
		const bytes = textEncoder.encode(data);
		output.push(bytes);
		options.onOutput?.(bytes.slice());
	});
	let exitSubscription;
	const exit = new Promise((resolve) => {
		exitSubscription = terminal.onExit(({ exitCode, signal }) => {
			dataSubscription.dispose();
			exitSubscription.dispose();
			inputClosed = true;
			output.close();
			resolve({
				code: exitCode,
				signal: signal ?? null
			});
		});
	});
	const abort = () => kill();
	options.signal?.addEventListener("abort", abort, { once: true });
	exit.finally(() => options.signal?.removeEventListener("abort", abort));
	return {
		output,
		exit,
		write: async (bytes) => {
			if (inputClosed) throw new LibterminalError("transport_closed", "PTY input is closed");
			const decoded = inputDecoder.decode(bytes, { stream: true });
			if (decoded) terminal.write(decoded);
		},
		resize: async (nextSize) => {
			assertTerminalSize(nextSize);
			terminal.resize(nextSize.columns, nextSize.rows);
		},
		close: async () => kill(),
		kill
	};
}
async function attachLocalStdio(terminal, options) {
	if (options?.signal?.aborted) {
		await terminal.close("aborted");
		return;
	}
	const stdin = options?.stdin ?? process.stdin;
	const stdout = options?.stdout ?? process.stdout;
	const output = terminal.output[Symbol.asyncIterator]();
	const aborted = abortPromise(options?.signal);
	const previousRaw = stdin.isTTY ? stdin.isRaw : false;
	const previousFlowing = stdin.readableFlowing;
	let rejectInputFailure = noop;
	const inputFailure = new Promise((_, reject) => {
		rejectInputFailure = reject;
	});
	inputFailure.catch(noop);
	let pendingInput = Promise.resolve();
	const writeInput = (data) => {
		const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
		pendingInput = pendingInput.then(async () => {
			await terminal.write?.(bytes);
		});
		pendingInput.catch(rejectInputFailure);
	};
	let rejectResizeFailure = noop;
	const resizeFailure = new Promise((_, reject) => {
		rejectResizeFailure = reject;
	});
	resizeFailure.catch(() => void 0);
	const resize = async () => {
		const size = terminalSize(stdout);
		await terminal.resize?.(size);
		options?.onResize?.(size);
	};
	let pendingResize = Promise.resolve();
	const handleResize = () => {
		pendingResize = pendingResize.then(resize);
		pendingResize.catch(rejectResizeFailure);
	};
	const abort = () => void terminal.close("aborted").catch(() => void 0);
	if (stdin.isTTY) {
		stdin.setRawMode(true);
		stdin.resume();
	}
	stdin.on("data", writeInput);
	stdout.on("resize", handleResize);
	options?.signal?.addEventListener("abort", abort, { once: true });
	let outputCompleted = false;
	try {
		await resize();
		for (;;) {
			const next = aborted ? await Promise.race([
				output.next(),
				aborted.promise,
				resizeFailure,
				inputFailure
			]) : await Promise.race([
				output.next(),
				resizeFailure,
				inputFailure
			]);
			if (next === abortedResult || next.done) {
				outputCompleted = next !== abortedResult;
				break;
			}
			await writeToStream(stdout, next.value);
		}
	} finally {
		aborted?.dispose();
		stdin.off("data", writeInput);
		stdout.off("resize", handleResize);
		try {
			if (!outputCompleted) {
				const returned = output.return?.();
				if (options?.signal?.aborted) Promise.resolve(returned).catch(noop);
				else await returned;
			}
			await pendingResize;
		} finally {
			options?.signal?.removeEventListener("abort", abort);
			if (stdin.isTTY) stdin.setRawMode(previousRaw);
			if (previousFlowing !== true) stdin.pause();
		}
	}
}
async function ensureNodePtySpawnHelperExecutable() {
	if (process.platform === "win32") return;
	let packageRoot;
	try {
		packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("node-pty"))));
	} catch {
		return;
	}
	for (const candidate of [path.join(packageRoot, "build", "Release", "spawn-helper"), path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")]) try {
		await fs.chmod(candidate, 493);
		return;
	} catch {}
}
async function readGhosttyAsset(pathname) {
	const asset = (await ghosttyAssets()).get(pathname);
	if (!asset) return null;
	return {
		body: await fs.readFile(asset.path),
		contentType: asset.contentType
	};
}
var AsyncByteQueue = class {
	maxBytes;
	onDrop;
	chunks = [];
	bytes = 0;
	waiters = [];
	closed = false;
	constructor(maxBytes = 1024 * 1024, onDrop) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("outputBufferBytes must be a positive safe integer");
		this.maxBytes = maxBytes;
		this.onDrop = onDrop;
	}
	[Symbol.asyncIterator]() {
		return this;
	}
	push(bytes) {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({
				done: false,
				value: bytes.slice()
			});
			return;
		}
		const chunk = bytes.byteLength > this.maxBytes ? bytes.slice(bytes.byteLength - this.maxBytes) : bytes.slice();
		let droppedBytes = bytes.byteLength - chunk.byteLength;
		while (this.chunks.length > 0 && this.bytes + chunk.byteLength > this.maxBytes) {
			const removedBytes = this.chunks.shift()?.byteLength ?? 0;
			this.bytes -= removedBytes;
			droppedBytes += removedBytes;
		}
		this.chunks.push(chunk);
		this.bytes += chunk.byteLength;
		if (droppedBytes > 0) this.onDrop?.(droppedBytes);
	}
	async next() {
		const chunk = this.chunks.shift();
		if (chunk) {
			this.bytes -= chunk.byteLength;
			return {
				done: false,
				value: chunk
			};
		}
		if (this.closed) return {
			done: true,
			value: void 0
		};
		return new Promise((resolve) => this.waiters.push(resolve));
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter({
			done: true,
			value: void 0
		});
	}
};
function currentEnvironment() {
	return Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== void 0));
}
function terminalSize(stdout) {
	return assertTerminalSize({
		columns: Math.max(20, stdout.columns || 120),
		rows: Math.max(10, stdout.rows || 34)
	});
}
function writeToStream(stream, bytes) {
	return new Promise((resolve, reject) => {
		stream.write(bytes, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}
async function ghosttyAssets() {
	const modulePath = fileURLToPath(import.meta.resolve("ghostty-web"));
	const browserExternalPath = await findBrowserExternalAsset(path.dirname(modulePath));
	return /* @__PURE__ */ new Map([
		[GHOSTTY_ASSET_PATHS.module, {
			path: modulePath,
			contentType: "text/javascript; charset=utf-8"
		}],
		[GHOSTTY_ASSET_PATHS.wasm, {
			path: fileURLToPath(import.meta.resolve("ghostty-web/ghostty-vt.wasm")),
			contentType: "application/wasm"
		}],
		[GHOSTTY_ASSET_PATHS.browserExternal, {
			path: browserExternalPath,
			contentType: "text/javascript; charset=utf-8"
		}]
	]);
}
async function findBrowserExternalAsset(distPath) {
	const matches = (await fs.readdir(distPath)).filter((entry) => /^__vite-browser-external-[A-Za-z0-9_-]+\.js$/.test(entry));
	if (matches.length !== 1) throw new LibterminalError("ghostty_unavailable", `expected one ghostty-web browser external asset in ${distPath}, found ${matches.length}`);
	return path.join(distPath, matches[0]);
}
function throwIfAborted(signal) {
	if (signal?.aborted) throw signal.reason ?? /* @__PURE__ */ new Error("The operation was aborted");
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
function noop() {}
//#endregion
export { GHOSTTY_ASSET_PATHS, attachLocalStdio, ensureNodePtySpawnHelperExecutable, loadNodePtyDriver, readGhosttyAsset, spawnLocalPty };
