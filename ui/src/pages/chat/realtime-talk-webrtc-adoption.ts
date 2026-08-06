import {
  measureRealtimeTalkRawEventBytes,
  RealtimeTalkAdoptionGate,
} from "./realtime-talk-adoption-gate.ts";

type WebRtcProviderEvent =
  | { type: "channel-open" }
  | { type: "message"; data: unknown }
  | { type: "camera-stream"; stream: MediaStream | null }
  | { type: "remote-track"; stream: MediaStream; track: MediaStreamTrack };

const MAX_PENDING_PROVIDER_EVENTS = 32;
const MAX_PENDING_PROVIDER_EVENT_BYTES = 128 * 1024;

export function createWebRtcAdoptionGate(options: {
  consume: (event: WebRtcProviderEvent) => void;
  onOverflow: () => void;
}): RealtimeTalkAdoptionGate<WebRtcProviderEvent> {
  return new RealtimeTalkAdoptionGate({
    maxCount: MAX_PENDING_PROVIDER_EVENTS,
    maxBytes: MAX_PENDING_PROVIDER_EVENT_BYTES,
    measure: (event) =>
      event.type === "message"
        ? measureRealtimeTalkRawEventBytes(event.data, MAX_PENDING_PROVIDER_EVENT_BYTES)
        : 1,
    consume: options.consume,
    onOverflow: options.onOverflow,
  });
}
