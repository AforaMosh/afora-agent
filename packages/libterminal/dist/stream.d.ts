//#region src/stream.d.ts
type SlowSubscriberPolicy = "disconnect" | "drop-oldest";
type FanoutEvent = {
  type: "subscriber-overflow";
  subscriberId: string;
  droppedBytes: number;
  policy: SlowSubscriberPolicy;
} | {
  type: "subscriber-closed";
  subscriberId: string;
  reason?: string;
};
type TerminalSubscription = AsyncIterable<Uint8Array> & {
  readonly id: string;
  close(reason?: string): void;
};
declare class BoundedReplayBuffer {
  readonly maxBytes: number;
  private chunks;
  private storedBytes;
  constructor(maxBytes?: number);
  get byteLength(): number;
  append(bytes: Uint8Array): void;
  snapshot(): Uint8Array[];
  clear(): void;
  private trim;
}
type TerminalFanoutOptions = {
  replayBytes?: number;
  subscriberBufferBytes?: number;
  slowSubscriberPolicy?: SlowSubscriberPolicy;
  onEvent?: (event: FanoutEvent) => void;
};
declare class TerminalFanout {
  private readonly replay;
  private readonly subscriberBufferBytes;
  private readonly slowSubscriberPolicy;
  private readonly onEvent?;
  private readonly subscribers;
  private closed;
  constructor(options?: TerminalFanoutOptions);
  get subscriberCount(): number;
  publish(bytes: Uint8Array): void;
  subscribe(id: string, options?: {
    replay?: boolean;
  }): TerminalSubscription;
  close(reason?: string): void;
  private removeSubscriber;
}
type BatchPublisherOptions = {
  maxBatchBytes?: number;
  flushIntervalMs?: number;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
};
declare class BatchPublisher {
  private readonly sink;
  private readonly maxBatchBytes;
  private readonly flushIntervalMs;
  private readonly onError?;
  private chunks;
  private bytes;
  private timer;
  private pending;
  private failure;
  private stopped;
  private abortSignal?;
  private abortHandler?;
  constructor(sink: (bytes: Uint8Array) => Promise<void>, options?: BatchPublisherOptions);
  write(bytes: Uint8Array): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
  private clearTimer;
  private detachAbort;
}
//#endregion
export { BatchPublisher, BatchPublisherOptions, BoundedReplayBuffer, FanoutEvent, SlowSubscriberPolicy, TerminalFanout, TerminalFanoutOptions, TerminalSubscription };