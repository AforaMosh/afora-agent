import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { BoundedSerialQueue } from "../shared/bounded-serial-queue.js";

const VOICE_TRANSCRIPT_MAX_CHARS = 8_000;
const VOICE_TRANSCRIPT_QUEUE_MAX_PENDING = 40;
export const VOICE_TRANSCRIPT_MAX_UNRESOLVED = VOICE_TRANSCRIPT_QUEUE_MAX_PENDING + 1;
export const CLIENT_VOICE_TRANSCRIPT_DRAIN_TIMEOUT_MS = 15_000;
export const CLIENT_VOICE_CLOSE_REQUEST_BUDGET_MS = 30_000;
export const CLIENT_VOICE_TERMINAL_ACK_GRACE_MS = 35_000;
const VOICE_TRANSCRIPT_QUEUE_MAX_PENDING_CHARS =
  VOICE_TRANSCRIPT_QUEUE_MAX_PENDING * VOICE_TRANSCRIPT_MAX_CHARS;
const VOICE_TRANSCRIPT_QUEUE_OVERFLOW_MESSAGE =
  "Voice transcript persistence could not keep up; the realtime session was stopped.";

export function normalizeVoiceTranscriptText(text: string): string {
  return truncateUtf16Safe(text.trim(), VOICE_TRANSCRIPT_MAX_CHARS);
}

export const VOICE_TRANSCRIPT_QUEUE_POLICY = {
  maxPendingCount: VOICE_TRANSCRIPT_QUEUE_MAX_PENDING,
  overflowMessage: VOICE_TRANSCRIPT_QUEUE_OVERFLOW_MESSAGE,
  createQueue: () =>
    new BoundedSerialQueue({
      maxPendingCount: VOICE_TRANSCRIPT_QUEUE_MAX_PENDING,
      maxPendingWeight: VOICE_TRANSCRIPT_QUEUE_MAX_PENDING_CHARS,
    }),
} as const;

type VoiceTranscriptOperationOwner = {
  queue: BoundedSerialQueue;
  closing?: { fence: string; promise: Promise<void> };
};

class VoiceTranscriptOperationRegistry {
  private readonly owners = new Map<string, VoiceTranscriptOperationOwner>();

  constructor(
    private readonly queuePolicy: Pick<typeof VOICE_TRANSCRIPT_QUEUE_POLICY, "createQueue">,
  ) {}

  private getOrCreate(key: string): VoiceTranscriptOperationOwner {
    const existing = this.owners.get(key);
    if (existing) {
      return existing;
    }
    const created = { queue: this.queuePolicy.createQueue() };
    this.owners.set(key, created);
    return created;
  }

  private cleanup(key: string, owner: VoiceTranscriptOperationOwner): void {
    if (
      this.owners.get(key) === owner &&
      !owner.closing &&
      owner.queue.isIdle &&
      !owner.queue.didOverflow
    ) {
      this.owners.delete(key);
    }
  }

  async run<T>(
    key: string,
    operation: () => Promise<T>,
    options: { weight?: number; waitForCapacity?: boolean } = {},
  ): Promise<T> {
    while (true) {
      const owner = this.getOrCreate(key);
      if (owner.closing) {
        if (options.waitForCapacity !== true) {
          throw new Error("voice transcript persistence session is closing");
        }
        try {
          await owner.closing.promise;
        } catch {
          // Control work retries on a fresh owner after a failed close releases this one.
        }
        continue;
      }
      // Control work may wait for the accepted transcript prefix, but must not
      // be the event that seals transcript admission. Real overflow stays terminal.
      const admission = owner.queue.enqueue(operation, {
        weight: options.weight,
        sealOnOverflow: options.waitForCapacity !== true,
      });
      if (admission.accepted) {
        void admission.completion.then(
          () => this.cleanup(key, owner),
          () => this.cleanup(key, owner),
        );
        return await admission.completion;
      }
      if (owner.queue.didOverflow || options.waitForCapacity !== true) {
        throw new Error(
          owner.queue.didOverflow
            ? "voice transcript persistence queue capacity exceeded"
            : "voice transcript persistence session is closed",
        );
      }
      if (admission.reason !== "capacity") {
        throw new Error("voice transcript persistence session is closed");
      }
      await owner.queue.flush();
      this.cleanup(key, owner);
    }
  }

  async close(key: string, fence: string, operation: () => Promise<void>): Promise<void> {
    while (true) {
      const owner = this.getOrCreate(key);
      if (owner.closing) {
        if (owner.closing.fence === fence) {
          return await owner.closing.promise;
        }
        await owner.closing.promise.catch(() => undefined);
        continue;
      }
      owner.queue.seal();
      const promise = owner.queue.flush({ requireSuccess: true }).then(operation);
      owner.closing = { fence, promise };
      try {
        await promise;
      } finally {
        if (this.owners.get(key) === owner && owner.closing?.promise === promise) {
          owner.closing = undefined;
          this.owners.delete(key);
        }
      }
      return;
    }
  }

  clear(): void {
    this.owners.clear();
  }
}

export function createVoiceTranscriptOperationRegistry(
  queuePolicy: Pick<typeof VOICE_TRANSCRIPT_QUEUE_POLICY, "createQueue">,
): VoiceTranscriptOperationRegistry {
  return new VoiceTranscriptOperationRegistry(queuePolicy);
}
