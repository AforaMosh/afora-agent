// Control UI chat module implements realtime talk behavior.
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type {
  TalkCatalogResult,
  TalkClientAllocationMutationResult,
  TalkClientAllocationTerminalEvent,
  TalkClientMutationResult,
} from "@openclaw/gateway-protocol";
import { normalizeTalkTransport } from "../../../../src/talk/talk-session-controller.js";
import { CLIENT_VOICE_CLOSE_REQUEST_BUDGET_MS } from "../../../../src/talk/voice-transcript.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  closeGatewayRelayRealtimeTalkSession,
  GatewayRelayRealtimeTalkTransport,
} from "./realtime-talk-gateway-relay.ts";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";
import type {
  RealtimeTalkCallbacks,
  RealtimeTalkGatewayRelaySessionResult,
  RealtimeTalkJsonPcmWebSocketSessionResult,
  RealtimeTalkSessionResult,
  RealtimeTalkStatus,
  RealtimeTalkTerminalPayload,
  RealtimeTalkTransport,
  RealtimeTalkTransportContext,
  RealtimeTalkWebRtcSdpSessionResult,
} from "./realtime-talk-shared.ts";
import { createRealtimeTalkEventEmitter } from "./realtime-talk-shared.ts";
import {
  type ClientVoiceSessionOwner,
  reserveClientVoiceSessionOwner,
} from "./realtime-talk-transcript-owner.ts";
import { RealtimeTalkVoiceSessionLifecycle } from "./realtime-talk-voice-session-lifecycle.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./realtime-talk-webrtc.ts";

export type { RealtimeTalkStatus };

type RealtimeTalkLaunchOptions = {
  provider?: string;
  model?: string;
  voice?: string;
  transport?: "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  reasoningEffort?: string;
};

type RealtimeTalkLocalOptions = {
  inputDeviceId?: string;
  videoDeviceId?: string;
};

const activeRealtimeTalkSessions = new Set<RealtimeTalkSession>();

export async function switchActiveRealtimeTalkCameras(
  videoDeviceId: string | undefined,
): Promise<void> {
  const failure = (
    await Promise.allSettled(
      [...activeRealtimeTalkSessions].map((session) =>
        session.switchCameraIfEnabled(videoDeviceId),
      ),
    )
  ).find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    throw failure.reason;
  }
}

type RealtimeTalkLaunchTransport = NonNullable<RealtimeTalkLaunchOptions["transport"]>;

type RealtimeTalkConfigResult = {
  config?: {
    talk?: {
      realtime?: {
        transport?: unknown;
      };
    };
  };
};

function normalizeLaunchTransport(value: unknown): RealtimeTalkLaunchTransport | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const transport = normalizeTalkTransport(value);
  return transport === "webrtc" ||
    transport === "provider-websocket" ||
    transport === "gateway-relay" ||
    transport === "managed-room"
    ? transport
    : undefined;
}

function createTransport(
  session: RealtimeTalkSessionResult,
  ctx: RealtimeTalkTransportContext,
): RealtimeTalkTransport {
  const transport = resolveTransport(session);
  if (transport === "webrtc") {
    return new WebRtcSdpRealtimeTalkTransport(session as RealtimeTalkWebRtcSdpSessionResult, ctx);
  }
  if (transport === "provider-websocket") {
    return new GoogleLiveRealtimeTalkTransport(
      session as RealtimeTalkJsonPcmWebSocketSessionResult,
      ctx,
    );
  }
  if (transport === "gateway-relay") {
    return new GatewayRelayRealtimeTalkTransport(
      session as RealtimeTalkGatewayRelaySessionResult,
      ctx,
    );
  }
  const unknownTransport = (session as { transport?: string }).transport ?? "unknown";
  throw new Error(`Unsupported realtime Talk transport: ${unknownTransport}`);
}

function resolveTransport(session: RealtimeTalkSessionResult): string {
  return normalizeTalkTransport((session as { transport?: string }).transport) ?? "webrtc";
}

function compactLaunchParams(
  params: RealtimeTalkLaunchOptions & {
    sessionKey: string;
    voiceSessionId?: string;
    mode?: string;
    brain?: string;
  },
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

export class RealtimeTalkSession {
  private transport: RealtimeTalkTransport | null = null;
  private pendingTransport: RealtimeTalkTransport | null = null;
  private closed = false;
  private lifecycleGeneration = 0;
  private videoEnabled = false;
  private videoOperation = 0;
  private terminalEventDisposer: (() => void) | undefined;
  private startTail: Promise<void> = Promise.resolve();
  private readonly voiceSessions: RealtimeTalkVoiceSessionLifecycle;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly sessionKey: string,
    private readonly callbacks: RealtimeTalkCallbacks = {},
    private readonly options: RealtimeTalkLaunchOptions = {},
    private readonly localOptions: RealtimeTalkLocalOptions = {},
  ) {
    this.voiceSessions = new RealtimeTalkVoiceSessionLifecycle(
      client,
      sessionKey,
      callbacks,
      (generation, message) => this.failTranscriptPersistence(generation, message),
    );
  }

  start(): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    const starting = this.startTail.then(
      () => this.startAttempt(generation),
      () => this.startAttempt(generation),
    );
    this.startTail = starting.catch(() => undefined);
    return starting;
  }

  private async startAttempt(lifecycleGeneration: number): Promise<void> {
    if (lifecycleGeneration !== this.lifecycleGeneration) {
      return;
    }
    const owner = reserveClientVoiceSessionOwner(this.client, this.sessionKey);
    let ownerTransferred = false;
    try {
      const isCurrent = () => !this.closed && lifecycleGeneration === this.lifecycleGeneration;
      this.stopPendingTransport();
      this.closed = false;
      this.callbacks.onStatus?.("connecting");
      const existingTransport = this.transport;
      const existingVoiceSession = this.voiceSessions.current;
      const providerVideoCapable = await this.resolveVideoCapability();
      if (!isCurrent()) {
        return;
      }
      // Declaring voice-transcript arms the server-side spoken-confirmation gate;
      // this client reports every finalized utterance, so the gate is completable.
      const capabilities: Array<"camera-frame" | "voice-transcript"> = ["voice-transcript"];
      if (providerVideoCapable) {
        capabilities.push("camera-frame");
      }
      const session = await this.createSession({ ...this.options, capabilities });
      const transport = resolveTransport(session);
      const allocationId = "allocationId" in session ? session.allocationId : undefined;
      // Managed-room stays unsupported here and carries no voice bookkeeping;
      // reject it before the voice-session requirement produces a misleading error.
      if (transport === "managed-room") {
        throw new Error("Managed-room realtime Talk sessions are not available in this UI yet");
      }
      const voiceSessionId =
        session.voiceSessionId ??
        (transport === "gateway-relay"
          ? (session as RealtimeTalkGatewayRelaySessionResult).relaySessionId
          : undefined);
      if (!voiceSessionId) {
        throw new Error("Realtime Talk session did not return a voice session id");
      }
      const createTerminal = "terminal" in session ? session.terminal : undefined;
      if (!isCurrent()) {
        await this.closeUnadoptedVoiceSession(voiceSessionId, transport, owner, allocationId);
        ownerTransferred = true;
        return;
      }
      if (
        existingVoiceSession?.owner &&
        (transport === "gateway-relay" || voiceSessionId !== existingVoiceSession.voiceSessionId)
      ) {
        await this.closeUnadoptedVoiceSession(voiceSessionId, transport, owner, allocationId);
        ownerTransferred = true;
        throw new Error("Realtime Talk replacement changed the active voice session");
      }
      const adoptedOwner =
        voiceSessionId === existingVoiceSession?.voiceSessionId && existingVoiceSession.owner
          ? existingVoiceSession.owner
          : owner;
      if (adoptedOwner !== owner) {
        owner.release();
      }
      const candidate = this.voiceSessions.prepareCandidate({
        voiceSessionId,
        allocationId,
        generation: lifecycleGeneration,
        serverOwned: transport === "gateway-relay",
        owner: adoptedOwner,
      });
      const reusesExistingOwner = adoptedOwner === existingVoiceSession?.owner;
      let nextTransport: RealtimeTalkTransport | null = null;
      let terminalOutcome: RealtimeTalkTerminalPayload | undefined;
      let terminalReported = false;
      let disposeTerminalEvent: (() => void) | undefined;
      let startResult: Awaited<ReturnType<RealtimeTalkTransport["start"]>>;
      const transportContext: RealtimeTalkTransportContext = {
        client: this.client,
        sessionKey: this.sessionKey,
        voiceSessionId,
        flushTranscriptWrites: () => this.voiceSessions.flush(),
        callbacks: candidate.callbacks,
        inputDeviceId: this.localOptions.inputDeviceId,
        videoDeviceId: this.localOptions.videoDeviceId,
        consultThinkingLevel: session.consultThinkingLevel,
        consultFastMode: session.consultFastMode,
      };
      transportContext.emitTalkEvent = createRealtimeTalkEventEmitter(transportContext, session);
      const retireCandidate = async (operation: "abort" | "close") => {
        disposeTerminalEvent?.();
        let preparedOwner = adoptedOwner;
        if (operation === "close" && !existingTransport && transport !== "gateway-relay") {
          candidate.adopt();
          await this.voiceSessions.flush();
          preparedOwner =
            this.voiceSessions.detachIfCurrent(lifecycleGeneration)?.owner ?? adoptedOwner;
        } else {
          candidate.discard();
        }
        const ownsPending = this.pendingTransport === nextTransport;
        if (ownsPending) {
          this.pendingTransport = null;
          nextTransport?.stop({ emitClosed: false });
        }
        try {
          if (allocationId) {
            if (operation === "close") {
              await this.requestBrowserAllocation("close", voiceSessionId, allocationId);
            } else {
              try {
                const result = await this.requestBrowserAllocation(
                  "abort",
                  voiceSessionId,
                  allocationId,
                );
                if (result.state === "terminal") {
                  await this.requestBrowserAllocation("close", voiceSessionId, allocationId);
                }
              } catch (error) {
                console.warn("Realtime Talk allocation abort failed", error);
              }
            }
          } else if (operation === "abort" && !reusesExistingOwner) {
            if (transport === "gateway-relay" && nextTransport) {
              preparedOwner.release();
            } else {
              await this.closeUnadoptedVoiceSession(voiceSessionId, transport, preparedOwner);
            }
            preparedOwner = existingVoiceSession?.owner ?? preparedOwner;
          }
        } finally {
          if (!reusesExistingOwner && (allocationId || operation === "close")) {
            preparedOwner.release();
          }
          ownerTransferred = true;
        }
      };
      const finalizeTerminal = (terminal: RealtimeTalkTerminalPayload, active = false) => {
        terminalOutcome ??= terminal;
        const message = terminal.message ?? "Realtime connection failed";
        if (!terminalReported && (active || !existingTransport)) {
          if (terminal.outcome === "error") {
            transportContext.emitTalkEvent?.({
              type: "session.error",
              payload: { message },
              final: true,
            });
          }
          transportContext.emitTalkEvent?.({
            type: "session.closed",
            payload: { outcome: terminal.outcome },
            final: true,
          });
          terminalReported = true;
        }
        nextTransport?.stop({ emitClosed: false });
        if (!active) {
          return;
        }
        this.stop();
        if (terminal.outcome === "error") {
          this.callbacks.onStatus?.("error", message);
        }
      };
      if (createTerminal) {
        finalizeTerminal(createTerminal);
        await retireCandidate("close");
        if (!existingTransport && createTerminal.outcome === "error") {
          this.callbacks.onStatus?.(
            "error",
            createTerminal.message ?? "Realtime connection failed",
          );
        }
        return;
      }
      try {
        nextTransport = createTransport(session, transportContext);
        this.pendingTransport = nextTransport;
        if (allocationId) {
          disposeTerminalEvent = this.client.addEventListener((event) => {
            const terminal = event.payload as TalkClientAllocationTerminalEvent;
            const active = this.voiceSessions.current?.allocationId === allocationId;
            if (
              event.event !== "talk.client.allocation.terminal" ||
              terminal?.allocationId !== allocationId ||
              terminalOutcome ||
              (!active && this.pendingTransport !== nextTransport)
            ) {
              return;
            }
            finalizeTerminal(terminal, active);
          });
        }
        this.callbacks.onVideoCapability?.(
          providerVideoCapable && typeof nextTransport.setVideoEnabled === "function",
        );
        startResult = await nextTransport.start();
      } catch (error) {
        if (terminalOutcome) {
          startResult = "cancelled";
        } else {
          await retireCandidate("abort");
          throw error;
        }
      }
      const candidateFailure = candidate.failure();
      if (candidateFailure) {
        await retireCandidate("abort");
        this.callbacks.onStatus?.("error", candidateFailure.message);
        throw candidateFailure;
      }
      if (
        (startResult === "cancelled" || !isCurrent() || this.pendingTransport !== nextTransport) &&
        !terminalOutcome
      ) {
        await retireCandidate("abort");
        return;
      }
      if (allocationId) {
        let result: TalkClientAllocationMutationResult;
        try {
          result = await this.requestBrowserAllocation("commit", voiceSessionId, allocationId);
        } catch (error) {
          if (!(error instanceof GatewayRequestError)) {
            candidate.discard();
            const active = this.shutdownTransport(undefined, { emitClosed: false });
            const message = "Realtime Talk allocation commit could not be confirmed";
            this.callbacks.onStatus?.("error", message);
            await Promise.all(
              active
                ? [retireCandidate("close"), this.voiceSessions.close(active)]
                : [retireCandidate("close")],
            );
            throw new Error(message, { cause: error });
          }
          await retireCandidate("abort");
          throw terminalOutcome?.message ? new Error(terminalOutcome.message) : error;
        }
        if (result.state === "terminal") {
          const terminal = terminalOutcome ?? result.terminal;
          finalizeTerminal(terminal);
          await retireCandidate("close");
          return;
        }
        if (result.state !== "committed") {
          await retireCandidate("close");
          throw new Error("Realtime Talk allocation commit returned an invalid result");
        }
        if (!isCurrent() || this.pendingTransport !== nextTransport) {
          await retireCandidate("close");
          return;
        }
      }
      if (!isCurrent() || this.pendingTransport !== nextTransport) {
        await retireCandidate(allocationId ? "close" : "abort");
        return;
      }
      const adoptedTransport = nextTransport;
      if (!adoptedTransport) {
        await retireCandidate(allocationId ? "close" : "abort");
        return;
      }
      this.pendingTransport = null;
      candidate.adopt();
      this.transport = adoptedTransport;
      this.terminalEventDisposer?.();
      this.terminalEventDisposer = disposeTerminalEvent;
      ownerTransferred = true;
      existingTransport?.stop({ emitClosed: false });
      try {
        adoptedTransport.activate?.();
      } catch (error) {
        const detached = this.shutdownTransport(lifecycleGeneration, { emitClosed: false });
        if (detached) {
          await this.voiceSessions.close(detached);
        }
        throw error;
      }
      if (terminalOutcome) {
        finalizeTerminal(terminalOutcome, true);
      }
    } finally {
      if (!ownerTransferred) {
        owner.release();
      }
    }
  }

  private async resolveVideoCapability(): Promise<boolean> {
    if (!this.callbacks.onVideoCapability) {
      return false;
    }
    try {
      const catalog = await this.client.request<TalkCatalogResult>(
        "talk.catalog",
        {},
        { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
      );
      const selectedProvider = this.options.provider ?? catalog.realtime.activeProvider;
      if (!selectedProvider) {
        return false;
      }
      return (
        catalog.realtime.providers.find(
          (provider) =>
            provider.id === selectedProvider || provider.aliases?.includes(selectedProvider),
        )?.supportsVideoFrames === true
      );
    } catch {
      return false;
    }
  }

  private async createSession(
    options: RealtimeTalkLaunchOptions & {
      capabilities?: Array<"camera-frame" | "voice-transcript">;
    },
  ): Promise<RealtimeTalkSessionResult> {
    const launchOptions = { ...options };
    try {
      return await this.client.request<RealtimeTalkSessionResult>(
        "talk.client.create",
        compactLaunchParams({
          sessionKey: this.sessionKey,
          voiceSessionId: this.voiceSessions.current?.voiceSessionId,
          ...launchOptions,
        }),
        { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
      );
    } catch (error) {
      let transport = launchOptions.transport;
      if (!transport) {
        let result: RealtimeTalkConfigResult;
        try {
          result = await this.client.request<RealtimeTalkConfigResult>(
            "talk.config",
            {},
            { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
          );
        } catch {
          throw error;
        }
        if (!result.config || typeof result.config !== "object") {
          throw error;
        }
        const configuredTransport = result.config?.talk?.realtime?.transport;
        if (configuredTransport !== undefined) {
          transport = normalizeLaunchTransport(configuredTransport);
          if (!transport) {
            throw error;
          }
        }
      }
      if (transport && transport !== "gateway-relay") {
        throw error;
      }
      const gatewayOptions = { ...launchOptions };
      delete gatewayOptions.capabilities;
      try {
        const relaySession = await this.client.request<RealtimeTalkSessionResult>(
          "talk.session.create",
          compactLaunchParams({
            sessionKey: this.sessionKey,
            ...gatewayOptions,
            mode: "realtime",
            transport: transport ?? "gateway-relay",
            brain: "agent-consult",
          }),
          { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
        );
        return resolveTransport(relaySession) === "gateway-relay"
          ? {
              ...relaySession,
              voiceSessionId: (relaySession as RealtimeTalkGatewayRelaySessionResult)
                .relaySessionId,
            }
          : relaySession;
      } catch {
        throw error;
      }
    }
  }

  stop(): void {
    const detached = this.shutdownTransport();
    this.callbacks.onStatus?.("idle");
    if (detached) {
      void this.voiceSessions.close(detached);
    }
  }

  private shutdownTransport(generation?: number, stopOptions?: { emitClosed?: boolean }) {
    this.lifecycleGeneration += 1;
    this.closed = true;
    this.videoOperation += 1;
    this.videoEnabled = false;
    activeRealtimeTalkSessions.delete(this);
    this.stopPendingTransport();
    this.terminalEventDisposer?.();
    this.terminalEventDisposer = undefined;
    const detached = this.voiceSessions.detachIfCurrent(generation);
    this.transport?.stop(...(stopOptions ? [stopOptions] : []));
    this.transport = null;
    return detached;
  }

  private stopPendingTransport(): void {
    const pendingTransport = this.pendingTransport;
    this.pendingTransport = null;
    pendingTransport?.stop({ emitClosed: false });
  }

  private async closeUnadoptedVoiceSession(
    voiceSessionId: string,
    transport: string,
    owner: ClientVoiceSessionOwner,
    allocationId?: string,
  ): Promise<void> {
    // A stopped or superseded create still owns the allocation returned to it.
    // Close at the provider boundary without installing a stale transport.
    if (allocationId) {
      try {
        const result = await this.requestBrowserAllocation("abort", voiceSessionId, allocationId);
        if (result.state === "terminal") {
          await this.requestBrowserAllocation("close", voiceSessionId, allocationId);
        }
      } catch (error) {
        console.warn("Realtime Talk allocation abort failed", error);
      } finally {
        owner.release();
      }
      return;
    }
    if (transport === "gateway-relay") {
      await closeGatewayRelayRealtimeTalkSession(this.client, voiceSessionId)
        .catch((error: unknown) => console.warn("Realtime Talk session close failed", error))
        .finally(owner.release);
      return;
    }
    await this.voiceSessions.closeUnadopted(voiceSessionId, owner);
  }

  private requestBrowserAllocation(
    operation: "commit" | "abort",
    voiceSessionId: string,
    allocationId: string,
  ): Promise<TalkClientAllocationMutationResult>;
  private requestBrowserAllocation(
    operation: "close",
    voiceSessionId: string,
    allocationId: string,
  ): Promise<TalkClientMutationResult>;
  private async requestBrowserAllocation(
    operation: "commit" | "abort" | "close",
    voiceSessionId: string,
    allocationId: string,
  ): Promise<TalkClientAllocationMutationResult | TalkClientMutationResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.client.request<
          TalkClientAllocationMutationResult | TalkClientMutationResult
        >(
          operation === "close" ? "talk.client.close" : `talk.client.${operation}`,
          { sessionKey: this.sessionKey, voiceSessionId, allocationId },
          {
            timeoutMs:
              operation === "close"
                ? CLIENT_VOICE_CLOSE_REQUEST_BUDGET_MS
                : DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
          },
        );
      } catch (error) {
        if (error instanceof GatewayRequestError || operation !== "commit" || attempt > 0) {
          throw error;
        }
      }
    }
  }

  private failTranscriptPersistence(generation: number, message: string): void {
    if (this.voiceSessions.current?.generation !== generation) {
      return;
    }
    const detached = this.shutdownTransport(generation);
    console.warn(message);
    this.callbacks.onStatus?.("error", message);
    if (detached) {
      void this.voiceSessions.close(detached);
    }
  }

  async setVideoEnabled(enabled: boolean): Promise<void> {
    const transport = this.transport;
    if (this.closed || !transport?.setVideoEnabled) {
      throw new Error("Camera is unavailable for this realtime session");
    }
    const operation = ++this.videoOperation;
    const previousEnabled = this.videoEnabled;
    this.videoEnabled = enabled;
    if (enabled) {
      activeRealtimeTalkSessions.add(this);
    } else {
      activeRealtimeTalkSessions.delete(this);
    }
    try {
      await transport.setVideoEnabled(enabled);
    } catch (error) {
      if (operation === this.videoOperation && !this.closed && this.transport === transport) {
        this.videoEnabled = previousEnabled;
        if (previousEnabled) {
          activeRealtimeTalkSessions.add(this);
        } else {
          activeRealtimeTalkSessions.delete(this);
        }
      }
      throw error;
    }
    if (operation === this.videoOperation && (this.closed || this.transport !== transport)) {
      this.videoEnabled = false;
      activeRealtimeTalkSessions.delete(this);
    }
  }

  async switchCamera(videoDeviceId: string | undefined): Promise<void> {
    const normalizedDeviceId = videoDeviceId?.trim() || undefined;
    this.localOptions.videoDeviceId = normalizedDeviceId;
    if (this.closed || !this.transport?.switchCamera) {
      throw new Error("Camera switching is unavailable for this realtime session");
    }
    await this.transport.switchCamera(normalizedDeviceId);
  }

  async switchCameraIfEnabled(videoDeviceId: string | undefined): Promise<void> {
    if (!this.videoEnabled) {
      return;
    }
    try {
      await this.switchCamera(videoDeviceId);
    } catch (error) {
      this.callbacks.onVideoError?.(error);
      throw error;
    }
  }
}
