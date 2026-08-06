// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { WebRtcSdpRealtimeTalkTransport } from "./realtime-talk-webrtc.ts";

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  send = vi.fn();
  close = vi.fn();
}

class FakePeerConnection extends EventTarget {
  static instance: FakePeerConnection | undefined;
  connectionState: RTCPeerConnectionState = "new";
  readonly channel = new FakeDataChannel();
  readonly addTrack = vi.fn();
  localDescription: RTCSessionDescriptionInit | null = null;

  constructor() {
    super();
    FakePeerConnection.instance = this;
  }

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "offer-sdp" };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }
  async setRemoteDescription(): Promise<void> {}
  close(): void {
    this.connectionState = "closed";
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps microphone, playback, and provider callbacks inert until adoption", async () => {
  const localTrack = { enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
  const localStream = {
    getAudioTracks: () => [localTrack],
    getTracks: () => [localTrack],
  } as unknown as MediaStream;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => localStream) },
  });
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch);
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const onStatus = vi.fn();
  const onTranscript = vi.fn();
  const transport = new WebRtcSdpRealtimeTalkTransport(
    { provider: "openai", transport: "webrtc", clientSecret: "secret" },
    { client: {} as never, sessionKey: "main", callbacks: { onStatus, onTranscript } },
  );

  await transport.start();
  const peer = FakePeerConnection.instance;
  const remoteTrack = Object.assign(new EventTarget(), {
    muted: false,
  }) as unknown as MediaStreamTrack;
  const trackEvent = new Event("track");
  Object.defineProperties(trackEvent, {
    streams: { value: [{} as MediaStream] },
    track: { value: remoteTrack },
  });
  peer?.channel.dispatchEvent(new Event("open"));
  peer?.channel.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "held until commit",
      }),
    }),
  );
  peer?.dispatchEvent(trackEvent);

  expect(localTrack.enabled).toBe(false);
  expect(onStatus).not.toHaveBeenCalled();
  expect(onTranscript).not.toHaveBeenCalled();
  expect(play).not.toHaveBeenCalled();

  transport.activate();

  expect(localTrack.enabled).toBe(true);
  expect(onStatus).toHaveBeenCalledWith("listening");
  expect(onTranscript).toHaveBeenCalledWith({
    role: "user",
    text: "held until commit",
    final: true,
  });
  expect(play).toHaveBeenCalledOnce();
  transport.stop();
});

it("publishes a camera enabled before commit exactly once after adoption", async () => {
  const localTrack = { enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
  const cameraTrack = Object.assign(new EventTarget(), {
    readyState: "live",
    stop: vi.fn(),
  }) as unknown as MediaStreamTrack;
  const localStream = {
    getAudioTracks: () => [localTrack],
    getTracks: () => [localTrack],
  } as unknown as MediaStream;
  const cameraStream = {
    getVideoTracks: () => [cameraTrack],
    getTracks: () => [cameraTrack],
  } as unknown as MediaStream;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValueOnce(localStream).mockResolvedValueOnce(cameraStream),
    },
  });
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const onVideoStream = vi.fn();
  const transport = new WebRtcSdpRealtimeTalkTransport(
    { provider: "openai", transport: "webrtc", clientSecret: "secret" },
    { client: {} as never, sessionKey: "main", callbacks: { onVideoStream } },
  );

  await transport.start();
  await transport.setVideoEnabled(true);
  expect(onVideoStream).not.toHaveBeenCalled();

  transport.activate();

  expect(onVideoStream).toHaveBeenCalledOnce();
  expect(onVideoStream).toHaveBeenCalledWith(cameraStream);
  transport.stop();
});

it("never publishes a provisional camera after the transport is discarded", async () => {
  const localTrack = { enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
  const stopCameraTrack = vi.fn();
  const cameraTrack = Object.assign(new EventTarget(), {
    readyState: "live",
    stop: stopCameraTrack,
  }) as unknown as MediaStreamTrack;
  const localStream = {
    getAudioTracks: () => [localTrack],
    getTracks: () => [localTrack],
  } as unknown as MediaStream;
  const cameraStream = {
    getVideoTracks: () => [cameraTrack],
    getTracks: () => [cameraTrack],
  } as unknown as MediaStream;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValueOnce(localStream).mockResolvedValueOnce(cameraStream),
    },
  });
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const onVideoStream = vi.fn();
  const transport = new WebRtcSdpRealtimeTalkTransport(
    { provider: "openai", transport: "webrtc", clientSecret: "secret" },
    { client: {} as never, sessionKey: "main", callbacks: { onVideoStream } },
  );

  await transport.start();
  await transport.setVideoEnabled(true);
  transport.stop({ emitClosed: false });

  expect(onVideoStream).not.toHaveBeenCalled();
  expect(stopCameraTrack).toHaveBeenCalledOnce();
});
