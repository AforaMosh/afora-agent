import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type {
  TalkCatalogResult,
  TalkClientAllocationMutationResult,
  TalkClientAllocationTerminalEvent,
} from "@openclaw/gateway-protocol";
import { normalizeTalkTransport } from "../../../../src/talk/talk-session-controller.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { GatewayRelayRealtimeTalkTransport } from "./realtime-talk-gateway-relay.ts";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";
import {
  createRealtimeTalkEventEmitter,
  runRealtimeTalkCleanup,
  runRealtimeTalkObservers as observe,
  type RealtimeTalkCallbacks,
  type RealtimeTalkGatewayRelaySessionResult,
  type RealtimeTalkJsonPcmWebSocketSessionResult,
  type RealtimeTalkSessionResult,
  type RealtimeTalkStatus,
  type RealtimeTalkTerminalPayload,
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
  type RealtimeTalkWebRtcSdpSessionResult,
} from "./realtime-talk-shared.ts";
import {
  type ClientVoiceSessionOwner,
  reserveClientVoiceSessionOwner,
} from "./realtime-talk-transcript-owner.ts";
import {
  closeGatewayRelayRealtimeTalkSession,
  RealtimeTalkVoiceSessionLifecycle,
} from "./realtime-talk-voice-session-lifecycle.ts";
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

function throwIfError(error: unknown): void {
  if (error) throw error;
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
    if (lifecycleGeneration !== this.lifecycleGeneration) return;
    const owner = reserveClientVoiceSessionOwner(this.client, this.sessionKey);
    let ownerTransferred = false;
    try {
      const isCurrent = () => !this.closed && lifecycleGeneration === this.lifecycleGeneration;
      this.stopPendingTransport();
      this.closed = false;
      const existingTransport = this.transport;
      const existingVoiceSession = this.voiceSessions.current;
      if (!existingTransport) {
        this.callbacks.onStatus?.("connecting");
      }
      const providerVideoCapable = await this.resolveVideoCapability();
      if (!isCurrent()) {
        return;
      }
      // This client reports every final utterance, so it can arm voice-transcript confirmation.
      const capabilities: Array<"camera-frame" | "voice-transcript"> = ["voice-transcript"];
      if (providerVideoCapable) {
        capabilities.push("camera-frame");
      }
      const session = await this.createSession({ ...this.options, capabilities });
      const transport = resolveTransport(session);
      const allocationId = "allocationId" in session ? session.allocationId : undefined;
      if (transport === "managed-room")
        throw new Error("Managed-room realtime Talk sessions are not available in this UI yet");
      const voiceSessionId =
        session.voiceSessionId ??
        (transport === "gateway-relay"
          ? (session as RealtimeTalkGatewayRelaySessionResult).relaySessionId
          : undefined);
      if (!voiceSessionId) {
        throw new Error("Realtime Talk session did not return a voice session id");
      }
      const createTerminal = "terminal" in session ? session.terminal : undefined;
      const retire = (retireOwner = owner) =>
        this.retireUnadopted(voiceSessionId, transport, retireOwner, allocationId);
      if (!isCurrent()) {
        ownerTransferred = true;
        return throwIfError(await retire());
      }
      if (
        existingVoiceSession?.owner &&
        (transport === "gateway-relay" || voiceSessionId !== existingVoiceSession.voiceSessionId)
      ) {
        const cleanupError = await retire();
        ownerTransferred = true;
        const message = "Realtime Talk replacement changed the active voice session";
        throw new Error(message, { cause: cleanupError });
      }
      const adoptedOwner =
        voiceSessionId === existingVoiceSession?.voiceSessionId && existingVoiceSession.owner
          ? existingVoiceSession.owner
          : owner;
      if (adoptedOwner !== owner) owner.release();
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
      let disposeTerminalEvent: (() => void) | undefined;
      let candidateRetirement: Promise<void> | undefined;
      let terminalRetirement: Promise<unknown> | undefined;
      let commitSent = false;
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
      const retireCandidate = (operation: "abort" | "close") =>
        (candidateRetirement ??= (async () => {
          let firstError: unknown = runRealtimeTalkCleanup(
            [
              () => disposeTerminalEvent?.(),
              () => this.pendingTransport === nextTransport && this.stopPendingTransport(),
            ],
            true,
          );
          let releaseOwner = !reusesExistingOwner;
          try {
            if (operation === "close" && !existingTransport && transport !== "gateway-relay") {
              const consumerError = candidate.adopt();
              const detached = this.voiceSessions.detachIfCurrent(lifecycleGeneration);
              releaseOwner = false;
              if (detached) {
                throwIfError(await this.voiceSessions.close(detached));
              }
              if (consumerError)
                console.warn("Realtime Talk candidate transcript callback failed", consumerError);
            } else {
              candidate.discard();
              if (allocationId && operation === "close") {
                await this.voiceSessions.closeAllocation(voiceSessionId, allocationId);
              } else if (allocationId) {
                const result = await this.requestBrowserAllocation(
                  "abort",
                  voiceSessionId,
                  allocationId,
                );
                if (result.state === "terminal")
                  await this.voiceSessions.closeAllocation(voiceSessionId, allocationId);
              } else if (operation === "abort" && !reusesExistingOwner) {
                releaseOwner = false;
                if (transport === "gateway-relay" && nextTransport) adoptedOwner.release();
                else throwIfError(await retire(adoptedOwner));
              }
            }
          } catch (error) {
            firstError ??= error;
          } finally {
            if (releaseOwner) adoptedOwner.release();
            ownerTransferred = true;
          }
          throwIfError(firstError);
        })());
      const retireBoth = async (report = true) => {
        const errors = await Promise.all([
          this.shutdownTransport(undefined, { emitClosed: false }, false).catch((error) => error),
          retireCandidate("close").catch((error) => error),
        ]);
        if (report && errors[0]) console.warn(errors[0]);
        if (report && errors[1]) console.warn("Realtime Talk candidate cleanup failed", errors[1]);
        return errors.find(Boolean);
      };
      const recordTerminal = (terminal: RealtimeTalkTerminalPayload, active = false) => {
        if (terminalOutcome) return;
        terminalOutcome = terminal;
        terminalRetirement = (
          active
            ? this.shutdownTransport(undefined, { emitClosed: false }, false)
            : retireCandidate("close")
        ).catch((error) => error);
      };
      const projectTerminal = () => {
        const message = terminalOutcome!.message ?? "Realtime connection failed";
        observe(
          () => {
            if (terminalOutcome!.outcome === "error")
              transportContext.emitTalkEvent?.({
                type: "session.error",
                payload: { message },
                final: true,
              });
          },
          () =>
            transportContext.emitTalkEvent?.({
              type: "session.closed",
              payload: { outcome: terminalOutcome!.outcome },
              final: true,
            }),
          () =>
            terminalOutcome!.outcome === "error"
              ? this.callbacks.onStatus?.("error", message)
              : this.callbacks.onStatus?.("idle"),
        );
      };
      const settleTerminal = async (
        terminal = terminalOutcome!,
        global = !existingTransport,
        primaryError?: unknown,
      ) => {
        const active = this.voiceSessions.current?.allocationId === allocationId;
        recordTerminal(terminal, active);
        // Active calls and provider errors project immediately; completed candidates wait.
        if (global && (active || terminalOutcome!.outcome === "error")) projectTerminal();
        const cleanupError =
          global && existingTransport && !active
            ? await retireBoth(false)
            : await terminalRetirement;
        const error =
          terminalOutcome!.outcome === "error"
            ? new Error(terminalOutcome!.message ?? "Realtime connection failed")
            : (primaryError ?? cleanupError);
        if (cleanupError && (error !== cleanupError || active))
          console.warn("Realtime Talk terminal cleanup failed", cleanupError);
        if (!active) throwIfError(error);
        if (global && !active && terminalOutcome!.outcome === "completed") projectTerminal();
      };
      if (createTerminal) return await settleTerminal(createTerminal);
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
            if (active) void settleTerminal(terminal, true);
            else recordTerminal(terminal);
          });
        }
        this.callbacks.onVideoCapability?.(
          providerVideoCapable && typeof nextTransport.setVideoEnabled === "function",
        );
        startResult = await nextTransport.start();
      } catch (error) {
        if (terminalOutcome) return await settleTerminal(undefined, undefined, error);
        await retireCandidate("abort").catch(console.warn);
        throw error;
      }
      if (terminalOutcome) return await settleTerminal();
      const candidateFailure = candidate.failure();
      if (candidateFailure) {
        await retireCandidate("abort").catch(console.warn);
        observe(() => this.callbacks.onStatus?.("error", candidateFailure.message));
        throw candidateFailure;
      }
      if (startResult === "cancelled" || !isCurrent() || this.pendingTransport !== nextTransport)
        return await retireCandidate("abort");
      if (allocationId) {
        let result: TalkClientAllocationMutationResult;
        try {
          result = await this.requestBrowserAllocation(
            "commit",
            voiceSessionId,
            allocationId,
            () => (commitSent = true),
          );
        } catch (error) {
          if (terminalOutcome)
            return await settleTerminal(undefined, commitSent || undefined, error);
          if (!commitSent) {
            await retireCandidate("abort").catch(console.warn);
            throw error;
          }
          const message = "Realtime Talk allocation commit could not be confirmed";
          observe(() => this.callbacks.onStatus?.("error", message));
          await retireBoth();
          throw new Error(message, { cause: error });
        }
        if (result.state === "terminal") return await settleTerminal(result.terminal);
        if (terminalOutcome) return await settleTerminal(undefined, true);
        if (result.state !== "committed") {
          await retireCandidate("close").catch(console.warn);
          throw new Error("Realtime Talk allocation commit returned an invalid result");
        }
      }
      const adoptedTransport = nextTransport;
      if (!adoptedTransport || !isCurrent() || this.pendingTransport !== adoptedTransport) {
        await retireCandidate(allocationId ? "close" : "abort");
        return;
      }
      const previousDisposer = this.terminalEventDisposer;
      this.pendingTransport = null;
      this.transport = adoptedTransport;
      this.terminalEventDisposer = disposeTerminalEvent;
      ownerTransferred = true;
      try {
        runRealtimeTalkCleanup([
          () => previousDisposer?.(),
          () => existingTransport?.stop({ emitClosed: false }),
          () => throwIfError(candidate.adopt()),
        ]);
        if (!isCurrent() || this.transport !== adoptedTransport) {
          await this.retireOwned(adoptedTransport, lifecycleGeneration);
          return;
        }
        adoptedTransport.activate?.();
      } catch (error) {
        await this.retireOwned(adoptedTransport, lifecycleGeneration).catch(console.warn);
        throw error;
      }
      if (!isCurrent() || this.transport !== adoptedTransport) {
        await this.retireOwned(adoptedTransport, lifecycleGeneration);
        return;
      }
    } finally {
      if (!ownerTransferred) owner.release();
    }
  }

  private async resolveVideoCapability(): Promise<boolean> {
    if (!this.callbacks.onVideoCapability) return false;
    try {
      const catalog = await this.client.request<TalkCatalogResult>(
        "talk.catalog",
        {},
        { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
      );
      const selectedProvider = this.options.provider ?? catalog.realtime.activeProvider;
      return (
        catalog.realtime.providers.find(
          (provider) =>
            selectedProvider &&
            (provider.id === selectedProvider || provider.aliases?.includes(selectedProvider)),
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
      const relaySession = await this.client
        .request<RealtimeTalkSessionResult>(
          "talk.session.create",
          compactLaunchParams({
            sessionKey: this.sessionKey,
            ...gatewayOptions,
            mode: "realtime",
            transport: transport ?? "gateway-relay",
            brain: "agent-consult",
          }),
          { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
        )
        .catch(() => Promise.reject(error));
      return resolveTransport(relaySession) === "gateway-relay"
        ? {
            ...relaySession,
            voiceSessionId: (relaySession as RealtimeTalkGatewayRelaySessionResult).relaySessionId,
          }
        : relaySession;
    }
  }

  stop(): void {
    void this.shutdownTransport().catch(console.warn);
    this.callbacks.onStatus?.("idle");
  }

  private async shutdownTransport(
    generation?: number,
    stopOptions?: { emitClosed?: boolean },
    reportFailure = true,
  ): Promise<void> {
    const controllerGeneration = ++this.lifecycleGeneration;
    this.closed = true;
    this.videoOperation += 1;
    this.videoEnabled = false;
    activeRealtimeTalkSessions.delete(this);
    const pendingTransport = this.pendingTransport;
    this.pendingTransport = null;
    const terminalEventDisposer = this.terminalEventDisposer;
    this.terminalEventDisposer = undefined;
    const transport = this.transport;
    this.transport = null;
    const detached = this.voiceSessions.detachIfCurrent(generation);
    const closePromise = detached
      ? this.voiceSessions
          .close(
            detached,
            reportFailure ? () => this.lifecycleGeneration === controllerGeneration : undefined,
          )
          .catch((error) => error)
      : undefined;
    const cleanupError = runRealtimeTalkCleanup(
      [
        () => pendingTransport?.stop({ emitClosed: false }),
        () => terminalEventDisposer?.(),
        () => transport?.stop(...(stopOptions ? [stopOptions] : [])),
      ],
      true,
    );
    const closeError = await closePromise;
    throwIfError(cleanupError ?? closeError);
  }

  private async retireOwned(transport: RealtimeTalkTransport, generation: number) {
    if (this.transport === transport && this.voiceSessions.current?.generation === generation) {
      await this.shutdownTransport(generation, { emitClosed: false });
    }
  }

  private stopPendingTransport(): void {
    const pendingTransport = this.pendingTransport;
    this.pendingTransport = null;
    pendingTransport?.stop({ emitClosed: false });
  }

  private async retireUnadopted(
    voiceSessionId: string,
    transport: string,
    owner: ClientVoiceSessionOwner,
    allocationId?: string,
  ): Promise<unknown> {
    // A stopped create still owns its allocation; close it without adopting stale state.
    if (allocationId) {
      try {
        const result = await this.requestBrowserAllocation("abort", voiceSessionId, allocationId);
        if (result.state === "terminal")
          await this.voiceSessions.closeAllocation(voiceSessionId, allocationId);
      } catch (error) {
        console.warn("Realtime Talk allocation abort failed", error);
        return error;
      } finally {
        owner.release();
      }
      return;
    }
    if (transport === "gateway-relay") {
      return await closeGatewayRelayRealtimeTalkSession(this.client, voiceSessionId)
        .then(
          () => undefined,
          (error: unknown) => (console.warn("Realtime Talk session close failed", error), error),
        )
        .finally(owner.release);
    }
    return await this.voiceSessions.closeUnadopted(voiceSessionId, owner);
  }

  private async requestBrowserAllocation(
    operation: "commit" | "abort",
    voiceSessionId: string,
    allocationId: string,
    onSent?: () => void,
  ): Promise<TalkClientAllocationMutationResult> {
    return this.client.request<TalkClientAllocationMutationResult>(
      `talk.client.${operation}`,
      { sessionKey: this.sessionKey, voiceSessionId, allocationId },
      {
        timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
        ...(onSent ? { onSent } : {}),
      },
    );
  }

  private failTranscriptPersistence(generation: number, message: string): void {
    if (this.voiceSessions.current?.generation !== generation) return;
    void this.shutdownTransport(generation).catch(console.warn);
    console.warn(message);
    observe(() => this.callbacks.onStatus?.("error", message));
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
