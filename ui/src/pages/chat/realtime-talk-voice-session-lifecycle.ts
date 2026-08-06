import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { BoundedBuffer } from "../../../../src/shared/bounded-buffer.js";
import {
  normalizeVoiceTranscriptText,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "../../../../src/talk/voice-transcript.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RealtimeTalkCallbacks } from "./realtime-talk-shared.ts";
import {
  type ClientVoiceSessionOwner,
  type DetachedVoiceSession,
  transcriptPersistenceAbortError,
  waitForTranscriptRetry,
} from "./realtime-talk-transcript-owner.ts";

type Transcript = Parameters<NonNullable<RealtimeTalkCallbacks["onTranscript"]>>[0];
type ActiveVoiceSession = {
  voiceSessionId: string;
  allocationId?: string;
  generation: number;
  serverOwned: boolean;
  owner?: ClientVoiceSessionOwner;
  nextSeq: number;
  queue: ReturnType<typeof VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue>;
};

export class RealtimeTalkVoiceSessionLifecycle {
  private active: ActiveVoiceSession | undefined;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly sessionKey: string,
    private readonly callbacks: RealtimeTalkCallbacks,
    private readonly onFatalPersistence: (generation: number, message: string) => void,
  ) {}

  get current(): Readonly<ActiveVoiceSession> | undefined {
    return this.active;
  }

  prepareCandidate(params: {
    voiceSessionId: string;
    allocationId?: string;
    generation: number;
    serverOwned: boolean;
    owner: ClientVoiceSessionOwner;
  }) {
    const current = this.active;
    const reusesCurrent =
      current?.owner === params.owner && current.voiceSessionId === params.voiceSessionId;
    let failure: Error | undefined;
    let discarded = false;
    const buffered = new BoundedBuffer<Transcript>(VOICE_TRANSCRIPT_QUEUE_POLICY.maxPendingCount, {
      mode: "fail-closed",
      onOverflow: () => (failure = new Error(VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage)),
    });
    const activeCallbacks = params.serverOwned
      ? this.callbacks
      : {
          ...this.callbacks,
          onTranscript: (entry: Transcript) => {
            const active = this.active;
            if (
              active?.generation === params.generation &&
              active.voiceSessionId === params.voiceSessionId
            ) {
              this.acceptTranscript(active, entry);
            } else if (entry.final) {
              const text = normalizeVoiceTranscriptText(entry.text);
              if (text) {
                buffered.push({ ...entry, text });
              }
            }
          },
        };
    return {
      callbacks: activeCallbacks,
      failure: () => failure,
      adopt: () => {
        if (discarded) {
          return;
        }
        const active =
          reusesCurrent && current
            ? current
            : {
                voiceSessionId: params.voiceSessionId,
                generation: params.generation,
                serverOwned: params.serverOwned,
                owner: params.serverOwned ? undefined : params.owner,
                nextSeq: 0,
                queue: VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue(),
              };
        active.allocationId = params.allocationId;
        active.generation = params.generation;
        active.serverOwned = params.serverOwned;
        if (params.serverOwned) {
          params.owner.release();
        }
        this.active = active;
        for (const entry of buffered.drain()) {
          this.acceptTranscript(active, entry);
        }
      },
      discard: () => {
        discarded = true;
        buffered.drain();
      },
    };
  }

  flush(): Promise<void> {
    return this.active?.queue.flush() ?? Promise.resolve();
  }

  detachIfCurrent(generation?: number): DetachedVoiceSession | undefined {
    const active = this.active;
    if (!active || (generation !== undefined && active.generation !== generation)) {
      return undefined;
    }
    active.queue.seal();
    this.active = undefined;
    return {
      voiceSessionId: active.voiceSessionId,
      allocationId: active.allocationId,
      serverOwned: active.serverOwned,
      generation: active.generation,
      transcriptQueue: active.queue,
      owner: active.owner,
    };
  }

  async close(detached: DetachedVoiceSession): Promise<void> {
    if (detached.serverOwned) {
      return;
    }
    const owner = detached.owner!;
    owner.beginDrain();
    try {
      await detached.transcriptQueue.flush();
      await this.retry(
        owner.closeSignal,
        async () =>
          await this.client.request(
            "talk.client.close",
            {
              sessionKey: this.sessionKey,
              voiceSessionId: detached.voiceSessionId,
              allocationId: detached.allocationId,
            },
            { signal: owner.closeSignal, timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
          ),
        "Realtime Talk voice session close failed",
      );
    } catch (error) {
      if (!owner.closeSignal.aborted) {
        console.warn("Realtime Talk voice session close failed", error);
        if (this.active?.generation === detached.generation || !this.active) {
          this.callbacks.onStatus?.("error", "Realtime Talk voice session close failed");
        }
      }
    } finally {
      owner.release();
    }
  }

  async closeUnadopted(voiceSessionId: string, owner: ClientVoiceSessionOwner): Promise<void> {
    const queue = VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue();
    queue.seal();
    await this.close({ voiceSessionId, serverOwned: false, transcriptQueue: queue, owner });
  }

  private acceptTranscript(active: ActiveVoiceSession, entry: Transcript): void {
    if (entry.final) {
      const text = normalizeVoiceTranscriptText(entry.text);
      if (text) {
        const entryId = String(active.nextSeq + 1);
        const admission = active.queue.enqueue(
          async () =>
            await this.retry(
              active.owner!.signal,
              async () =>
                await this.client.request(
                  "talk.client.transcript",
                  {
                    sessionKey: this.sessionKey,
                    voiceSessionId: active.voiceSessionId,
                    entryId,
                    role: entry.role,
                    text,
                    timestamp: Date.now(),
                  },
                  {
                    signal: active.owner!.signal,
                    timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
                  },
                ),
              "voice transcript save failed",
            ),
          { weight: text.length },
        );
        if (!admission.accepted) {
          if (admission.reason === "overflow") {
            this.onFatalPersistence(
              active.generation,
              VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage,
            );
          }
          return;
        }
        active.nextSeq += 1;
        void admission.completion.catch((error: unknown) => {
          if (active.owner!.signal.aborted) {
            return;
          }
          const detail = `Voice transcript could not be saved: ${error instanceof Error ? error.message : String(error)}`;
          console.warn(detail, error);
          if (this.active?.generation === active.generation) {
            this.callbacks.onStatus?.("error", detail);
          }
        });
      }
    }
    this.callbacks.onTranscript?.(entry);
  }

  private async retry<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
    failureMessage: string,
  ): Promise<T> {
    let lastError: unknown;
    for (const delayMs of [0, 500, 2_000]) {
      if (delayMs > 0) {
        await waitForTranscriptRetry(delayMs, signal);
      } else if (signal.aborted) {
        throw transcriptPersistenceAbortError();
      }
      try {
        return await operation();
      } catch (error) {
        if (signal.aborted) {
          throw transcriptPersistenceAbortError();
        }
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(failureMessage, { cause: lastError });
  }
}
