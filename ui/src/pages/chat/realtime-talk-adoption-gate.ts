type AdoptionGateState = "pending" | "draining" | "adopted" | "discarded";

type RealtimeTalkAdoptionGateOptions<T> = {
  maxCount: number;
  maxBytes: number;
  measure: (event: T) => number;
  consume: (event: T) => void;
  onOverflow: () => void;
};

export class RealtimeTalkAdoptionGate<T> {
  private state: AdoptionGateState = "pending";
  private events: Array<{ event: T; bytes: number }> = [];
  private eventBytes = 0;

  constructor(private readonly options: RealtimeTalkAdoptionGateOptions<T>) {}

  get currentState(): AdoptionGateState {
    return this.state;
  }

  push(event: T): boolean {
    if (this.state === "discarded") {
      return false;
    }
    if (this.state === "adopted") {
      this.options.consume(event);
      return true;
    }
    const eventBytes = this.options.measure(event);
    if (
      this.events.length >= this.options.maxCount ||
      eventBytes > this.options.maxBytes - this.eventBytes
    ) {
      this.discard();
      this.options.onOverflow();
      return false;
    }
    this.events.push({ event, bytes: eventBytes });
    this.eventBytes += eventBytes;
    return true;
  }

  adopt(): boolean {
    if (this.state !== "pending") {
      return false;
    }
    this.state = "draining";
    while (this.events.length > 0) {
      const queued = this.events.shift();
      if (!queued) {
        break;
      }
      this.eventBytes -= queued.bytes;
      this.options.consume(queued.event);
      if (this.state !== "draining") {
        return true;
      }
    }
    if (this.state === "draining") {
      this.state = "adopted";
      this.eventBytes = 0;
    }
    return true;
  }

  discard(): void {
    this.state = "discarded";
    this.events = [];
    this.eventBytes = 0;
  }
}

export function measureRealtimeTalkRawEventBytes(data: unknown, maxBytes: number): number {
  if (typeof data === "string") {
    return new TextEncoder().encode(data).byteLength;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.size;
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  // Unknown browser payloads cannot be proven bounded, so fail the provisional session closed.
  return maxBytes + 1;
}
