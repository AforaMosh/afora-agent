import { LibterminalError } from "./index.js";
//#region src/stream.ts
var BoundedReplayBuffer = class {
	maxBytes;
	chunks = [];
	storedBytes = 0;
	constructor(maxBytes = 512 * 1024) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative safe integer");
		this.maxBytes = maxBytes;
	}
	get byteLength() {
		return this.storedBytes;
	}
	append(bytes) {
		if (bytes.byteLength === 0 || this.maxBytes === 0) return;
		const chunk = bytes.byteLength > this.maxBytes ? bytes.slice(bytes.byteLength - this.maxBytes) : bytes.slice();
		this.chunks.push(chunk);
		this.storedBytes += chunk.byteLength;
		this.trim();
	}
	snapshot() {
		return this.chunks.map((chunk) => chunk.slice());
	}
	clear() {
		this.chunks = [];
		this.storedBytes = 0;
	}
	trim() {
		while (this.storedBytes > this.maxBytes) {
			const chunk = this.chunks[0];
			if (!chunk) return;
			const excess = this.storedBytes - this.maxBytes;
			if (excess >= chunk.byteLength) {
				this.chunks.shift();
				this.storedBytes -= chunk.byteLength;
				continue;
			}
			this.chunks[0] = chunk.slice(excess);
			this.storedBytes -= excess;
		}
	}
};
var TerminalFanout = class {
	replay;
	subscriberBufferBytes;
	slowSubscriberPolicy;
	onEvent;
	subscribers = /* @__PURE__ */ new Map();
	closed = false;
	constructor(options) {
		this.replay = new BoundedReplayBuffer(options?.replayBytes);
		this.subscriberBufferBytes = options?.subscriberBufferBytes ?? 1024 * 1024;
		if (!Number.isSafeInteger(this.subscriberBufferBytes) || this.subscriberBufferBytes < 1) throw new RangeError("subscriberBufferBytes must be a positive safe integer");
		this.slowSubscriberPolicy = options?.slowSubscriberPolicy ?? "disconnect";
		this.onEvent = options?.onEvent;
	}
	get subscriberCount() {
		return this.subscribers.size;
	}
	publish(bytes) {
		if (this.closed || bytes.byteLength === 0) return;
		this.replay.append(bytes);
		for (const [subscriberId, subscriber] of this.subscribers) {
			const droppedBytes = subscriber.enqueue(bytes, this.slowSubscriberPolicy);
			if (droppedBytes === 0) continue;
			this.onEvent?.({
				type: "subscriber-overflow",
				subscriberId,
				droppedBytes,
				policy: this.slowSubscriberPolicy
			});
			if (this.slowSubscriberPolicy === "disconnect") this.removeSubscriber(subscriberId, "subscriber buffer overflow");
		}
	}
	subscribe(id, options) {
		if (this.closed) throw new LibterminalError("transport_closed", "terminal fanout is closed");
		if (this.subscribers.has(id)) throw new Error(`terminal subscriber ${id} already exists`);
		const subscriber = new SubscriberQueue(this.subscriberBufferBytes);
		this.subscribers.set(id, subscriber);
		if (options?.replay !== false) for (const chunk of this.replay.snapshot()) subscriber.enqueue(chunk, "drop-oldest");
		return {
			id,
			[Symbol.asyncIterator]: () => subscriber,
			close: (reason) => this.removeSubscriber(id, reason)
		};
	}
	close(reason) {
		if (this.closed) return;
		this.closed = true;
		for (const subscriberId of this.subscribers.keys()) this.removeSubscriber(subscriberId, reason);
		this.replay.clear();
	}
	removeSubscriber(id, reason) {
		const subscriber = this.subscribers.get(id);
		if (!subscriber) return;
		this.subscribers.delete(id);
		subscriber.close();
		this.onEvent?.({
			type: "subscriber-closed",
			subscriberId: id,
			reason
		});
	}
};
var BatchPublisher = class {
	sink;
	maxBatchBytes;
	flushIntervalMs;
	onError;
	chunks = [];
	bytes = 0;
	timer;
	pending = Promise.resolve();
	failure;
	stopped = false;
	abortSignal;
	abortHandler;
	constructor(sink, options) {
		this.sink = sink;
		this.maxBatchBytes = options?.maxBatchBytes ?? 64 * 1024;
		this.flushIntervalMs = options?.flushIntervalMs ?? 40;
		this.onError = options?.onError;
		if (!Number.isSafeInteger(this.maxBatchBytes) || this.maxBatchBytes < 1) throw new RangeError("maxBatchBytes must be a positive safe integer");
		if (!Number.isSafeInteger(this.flushIntervalMs) || this.flushIntervalMs < 0) throw new RangeError("flushIntervalMs must be a non-negative safe integer");
		if (options?.signal?.aborted) {
			this.stopped = true;
			return;
		}
		this.abortSignal = options?.signal;
		this.abortHandler = () => void this.stop().catch((error) => this.onError?.(error));
		this.abortSignal?.addEventListener("abort", this.abortHandler, { once: true });
	}
	write(bytes) {
		if (this.stopped || bytes.byteLength === 0) return;
		this.chunks.push(bytes.slice());
		this.bytes += bytes.byteLength;
		if (this.bytes >= this.maxBatchBytes) {
			this.flush().catch((error) => this.onError?.(error));
			return;
		}
		if (!this.timer) this.timer = setTimeout(() => {
			this.flush().catch((error) => this.onError?.(error));
		}, this.flushIntervalMs);
	}
	async flush() {
		this.clearTimer();
		if (this.failure) throw this.failure;
		if (this.chunks.length === 0) {
			await this.pending;
			return;
		}
		const batch = concatenate(this.chunks, this.bytes);
		this.chunks = [];
		this.bytes = 0;
		this.pending = this.pending.then(() => this.sink(batch)).catch((error) => {
			this.failure = error;
			throw error;
		});
		await this.pending;
	}
	async stop() {
		this.detachAbort();
		if (this.stopped) {
			await this.pending;
			return;
		}
		this.stopped = true;
		await this.flush();
	}
	clearTimer() {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = void 0;
	}
	detachAbort() {
		if (this.abortSignal && this.abortHandler) this.abortSignal.removeEventListener("abort", this.abortHandler);
		this.abortSignal = void 0;
		this.abortHandler = void 0;
	}
};
var SubscriberQueue = class {
	maxBytes;
	chunks = [];
	bytes = 0;
	waiters = [];
	closed = false;
	constructor(maxBytes) {
		this.maxBytes = maxBytes;
	}
	enqueue(bytes, policy) {
		if (this.closed || bytes.byteLength === 0) return 0;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({
				done: false,
				value: bytes.slice()
			});
			return 0;
		}
		if (this.bytes + bytes.byteLength <= this.maxBytes) {
			this.chunks.push(bytes.slice());
			this.bytes += bytes.byteLength;
			return 0;
		}
		if (policy === "disconnect") return bytes.byteLength;
		let droppedBytes = 0;
		while (this.chunks.length > 0 && this.bytes + bytes.byteLength > this.maxBytes) {
			const removedBytes = this.chunks.shift()?.byteLength ?? 0;
			this.bytes -= removedBytes;
			droppedBytes += removedBytes;
		}
		const chunk = bytes.byteLength > this.maxBytes ? bytes.slice(bytes.byteLength - this.maxBytes) : bytes.slice();
		this.chunks.push(chunk);
		this.bytes += chunk.byteLength;
		return droppedBytes + Math.max(0, bytes.byteLength - chunk.byteLength);
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
function concatenate(chunks, byteLength) {
	const result = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}
//#endregion
export { BatchPublisher, BoundedReplayBuffer, TerminalFanout };
