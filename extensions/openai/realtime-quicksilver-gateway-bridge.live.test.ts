import { createHash } from "node:crypto";
import {
  readCodexCliCredentialsCached,
  resolveProviderOAuthAccess,
} from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it } from "vitest";
import { resolveCodexAuthIdentity } from "./openai-chatgpt-auth-identity.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import {
  OpenAIQuicksilverAudioPeer,
  type OpenAIQuicksilverAudioPeerContract,
} from "./realtime-quicksilver-peer.runtime.js";
import type { OpenAIQuicksilverAuth } from "./realtime-quicksilver-wire.js";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

const LIVE_ENABLED =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_GPT_LIVE === "1";
const describeLive = LIVE_ENABLED ? describe : describe.skip;
const LIVE_TIMEOUT_MS = 60_000;
const MAX_PENDING_AUDIO_BYTES = 240_000;

type TestableGatewayBridge = {
  pendingAudio: Buffer;
};

type WeriftModule = typeof import("werift");
type TestableAudioPeer = {
  state: {
    encoder: { encode(samples: Int16Array, options: { frameSize: number }): Uint8Array };
    peer: InstanceType<WeriftModule["RTCPeerConnection"]>;
    transceiver: ReturnType<InstanceType<WeriftModule["RTCPeerConnection"]>["addTransceiver"]>;
  };
};

async function waitForLiveCondition(
  predicate: () => boolean,
  describeFailure: () => string,
  timeoutMs = 45_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(describeFailure());
}

async function resolveLiveOAuthProfile(): Promise<
  Extract<OpenAIQuicksilverAuth, { type: "oauth" }> | undefined
> {
  try {
    const access = await resolveProviderOAuthAccess({
      provider: "openai",
      includeExternalCliAuth: false,
    });
    if (access) {
      if (!access.accountId) {
        throw new Error("The selected ChatGPT OAuth profile is missing its account id");
      }
      return { type: "oauth", token: access.accessToken, accountId: access.accountId };
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AuthProfileMigrationRequiredError") {
      throw error;
    }
  }
  const credential = readCodexCliCredentialsCached({ allowKeychainPrompt: false, ttlMs: 0 });
  if (!credential) {
    return undefined;
  }
  const accountId =
    credential.accountId ?? resolveCodexAuthIdentity({ accessToken: credential.access }).accountId;
  return accountId ? { type: "oauth", token: credential.access, accountId } : undefined;
}

describeLive("OpenAI GPT-Live gateway WebRTC peer", () => {
  it(
    "creates an OAuth call, joins sideband, and receives audio",
    async ({ skip }) => {
      const auth = await resolveLiveOAuthProfile();
      if (!auth) {
        skip("No ChatGPT OAuth profile is available");
        return;
      }

      let ready!: () => void;
      let audioObserved!: (source: string) => void;
      let fail!: (error: Error) => void;
      const eventTypes: string[] = [];
      const readyResult = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const audioResult = new Promise<string>((resolve) => {
        audioObserved = resolve;
      });
      const failureResult = new Promise<never>((_resolve, reject) => {
        fail = (error) => reject(new Error(`${error.message}; events=${eventTypes.join(",")}`));
      });
      const bridge = new OpenAIQuicksilverGatewayBridge({
        providerConfig: {},
        model: "gpt-live-1-boulder-alpha",
        voice: "marin",
        instructions:
          "This is a live transport check. Immediately say: OpenClaw gateway relay test OK.",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio: (audio) => {
          if (audio.length > 0) {
            audioObserved("decoded-pcm");
          }
        },
        onClearAudio: () => undefined,
        onEvent: (event) => eventTypes.push(event.type),
        onReady: ready,
        onError: fail,
        runAgentConsult: async () => ({ text: "The live transport check is complete." }),
        logger: { debug: () => undefined, warn: () => undefined },
        resolveAuth: async () => auth,
      });

      try {
        await bridge.connect();
        await expect(Promise.race([readyResult, failureResult])).resolves.toBeUndefined();
        await expect(Promise.race([audioResult, failureResult])).resolves.toBe("decoded-pcm");
      } finally {
        bridge.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "compares identical microphone speech before adoption and after media connection",
    async ({ skip }) => {
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        skip("No OpenAI Platform API key is available for the speech fixture");
        return;
      }

      const speechProvider = buildOpenAISpeechProvider();
      const synthesized = await speechProvider.synthesizeTelephony?.({
        text: "Please delegate the word glacier.",
        cfg: { plugins: { enabled: true } } as never,
        providerConfig: {
          apiKey,
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          speed: 1.4,
        },
        timeoutMs: 45_000,
      });
      if (!synthesized) {
        throw new Error("OpenAI speech provider did not return a telephony fixture");
      }
      expect(synthesized.outputFormat).toBe("pcm");
      expect(synthesized.sampleRate).toBe(24_000);
      const inputAudio = Buffer.concat([synthesized.audioBuffer, Buffer.alloc(24_000 * 2)]);
      expect(inputAudio.byteLength).toBeLessThanOrEqual(MAX_PENDING_AUDIO_BYTES);
      let peak = 0;
      let squared = 0;
      for (let offset = 0; offset < inputAudio.length; offset += 2) {
        const sample = inputAudio.readInt16LE(offset);
        peak = Math.max(peak, Math.abs(sample));
        squared += sample * sample;
      }
      const fixture = {
        bytes: inputAudio.length,
        durationMs: Math.round((inputAudio.length / (24_000 * 2)) * 1000),
        peak,
        rms: Math.round(Math.sqrt(squared / (inputAudio.length / 2))),
        sha256: createHash("sha256").update(inputAudio).digest("hex"),
      };
      expect(fixture.peak).toBeGreaterThan(0);

      const runCase = async (mode: "before-adoption" | "after-connected") => {
        const startedAt = performance.now();
        const timestamps: Record<string, number> = {};
        const mark = (name: string) =>
          (timestamps[name] ??= Math.round(performance.now() - startedAt));
        const bounded = (values: string[], value: string, limit = 24) => {
          if (values.length < limit) {
            values.push(value);
          }
        };
        const track = (prefix: string) => (state: unknown) =>
          bounded(states, `${prefix}:${String(state)}`, 16);
        const states: string[] = [],
          eventTypes: string[] = [],
          transcripts: string[] = [];
        const clean = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 160);
        let errors = 0;
        let marker = false;
        let queuedAtInjection: number | undefined;
        let transportAtInjection: Record<string, unknown> | undefined;
        const egress = { encode: 0, senderRtp: 0, dtlsRtp: 0 };
        const wrap = (target: object, key: string, counter: keyof typeof egress, stamp: string) => {
          const original = Reflect.get(target, key);
          Reflect.set(target, key, function (this: object, ...args: unknown[]) {
            egress[counter] += 1;
            mark(stamp);
            return Reflect.apply(original, this, args);
          });
        };
        const describeSdp = (sdp: string) => ({
          bytes: sdp.length,
          candidates: sdp.match(/^a=candidate:/gm)?.length ?? 0,
          opus: /^a=rtpmap:111 OPUS\/48000\/2$/im.test(sdp),
        });
        let offer: ReturnType<typeof describeSdp> | undefined;
        let answer: ReturnType<typeof describeSdp> | undefined;
        let peer: TestableAudioPeer | undefined;
        const createdSignal = Promise.withResolvers<void>();
        const adoption = Promise.withResolvers<void>();
        const bridge = new OpenAIQuicksilverGatewayBridge({
          providerConfig: {},
          model: "gpt-live-1-boulder-alpha",
          voice: "marin",
          instructions: "Listen to the user. Do not speak or delegate.",
          audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
          onAudio: () => undefined,
          onClearAudio: () => undefined,
          onEvent: (event) => bounded(eventTypes, event.type),
          onReady: () => mark("sidebandReady"),
          onTranscript: (role, text, final) => {
            if (role === "user" && final) {
              transcripts.push(clean(text));
              mark("finalTranscript");
            }
          },
          onError: () => (errors += 1),
          runAgentConsult: async () => ({ text: "Unexpected delegation." }),
          logger: { debug: () => undefined, warn: () => undefined },
          resolveAuth: async () => ({ type: "api-key", token: apiKey }),
          createPeer: async (callbacks, signal): Promise<OpenAIQuicksilverAudioPeerContract> => {
            const created = await OpenAIQuicksilverAudioPeer.create({ callbacks, signal });
            peer = created as unknown as TestableAudioPeer;
            mark("peerCreated");
            createdSignal.resolve();
            const sender = peer.state.transceiver.sender;
            const dtls = sender.dtlsTransport;
            wrap(peer.state.encoder, "encode", "encode", "firstEncode");
            wrap(sender, "sendRtp", "senderRtp", "firstSenderRtp");
            wrap(dtls, "sendRtp", "dtlsRtp", "firstDtlsRtp");
            peer.state.peer.connectionStateChange.subscribe(track("peer"));
            peer.state.peer.iceConnectionStateChange.subscribe(track("ice"));
            dtls.onStateChange.subscribe(track("dtls"));
            const createOffer = created.createOffer.bind(created);
            created.createOffer = async () => {
              const sdp = await createOffer();
              offer = describeSdp(sdp);
              mark("offer");
              return sdp;
            };
            const applyAnswer = created.applyAnswer.bind(created);
            created.applyAnswer = async (sdp) => {
              answer = describeSdp(sdp);
              await applyAnswer(sdp);
              mark("answer");
            };
            if (mode === "before-adoption") {
              await adoption.promise;
            }
            return created;
          },
        });
        mark("bridgeConnect");
        const connection = bridge.connect();
        const snapshot = (failure?: unknown) => {
          const sender = peer?.state.transceiver.sender;
          const dtls = sender?.dtlsTransport;
          const pair = dtls?.iceTransport.getSelectedCandidatePair();
          const trace = { mode, timestamps, states, offer, answer, transportAtInjection };
          const observed = {
            queuedAtInjection,
            eventTypes,
            transcripts,
            errors,
            marker,
            failure: failure instanceof Error ? clean(failure.message) : failure,
          };
          return {
            ...trace,
            egress: {
              ...egress,
              dtlsBytes: dtls?.bytesSent ?? 0,
              dtlsPackets: dtls?.packetsSent ?? 0,
              candidateBytes: pair?.bytesSent ?? 0,
              candidatePackets: pair?.packetsSent ?? 0,
              candidateRoute:
                pair?.localCandidate && pair.remoteCandidate
                  ? `${pair.localCandidate.protocol}:${pair.localCandidate.type}->${pair.remoteCandidate.protocol}:${pair.remoteCandidate.type}`
                  : undefined,
            },
            pendingAfter: (bridge as unknown as TestableGatewayBridge).pendingAudio.length,
            ...observed,
          };
        };
        try {
          if (mode === "before-adoption") {
            await createdSignal.promise;
          } else {
            await connection;
            await waitForLiveCondition(
              () =>
                peer?.state.transceiver.sender.dtlsTransport.state === "connected" &&
                Boolean(
                  peer.state.transceiver.sender.dtlsTransport.iceTransport.getSelectedCandidatePair(),
                ),
              () => "media transport did not connect",
              30_000,
            );
            mark("mediaConnected");
          }
          const senderAtInjection = peer?.state.transceiver.sender;
          const dtlsAtInjection = senderAtInjection?.dtlsTransport;
          transportAtInjection = {
            peer: peer?.state.peer.connectionState,
            ice: peer?.state.peer.iceConnectionState,
            dtls: dtlsAtInjection?.state,
            codec: senderAtInjection?.codec?.str,
          };
          mark("injected");
          for (let offset = 0; offset < inputAudio.length; offset += 8_192) {
            bridge.sendAudio(Buffer.from(inputAudio.subarray(offset, offset + 8_192)));
          }
          queuedAtInjection = (bridge as unknown as TestableGatewayBridge).pendingAudio.length;
          adoption.resolve();
          await connection;
          try {
            await waitForLiveCondition(
              () => transcripts.some((text) => text.toLowerCase().includes("glacier")),
              () => "marker transcript was not observed",
              30_000,
            );
            marker = true;
          } catch {}
          return snapshot();
        } catch (error) {
          return snapshot(error);
        } finally {
          adoption.resolve();
          bridge.close();
        }
      };

      const beforeAdoption = await runCase("before-adoption");
      const afterConnected = await runCase("after-connected");
      const cases = { fixture, beforeAdoption, afterConnected };
      console.log(JSON.stringify({ proof: "gpt-live-gateway-a-b-audio-egress", ...cases }));
      expect(afterConnected).toMatchObject({ failure: undefined, marker: true });
      expect(beforeAdoption).toMatchObject({ failure: undefined, marker: true });
    },
    LIVE_TIMEOUT_MS * 3,
  );
});
