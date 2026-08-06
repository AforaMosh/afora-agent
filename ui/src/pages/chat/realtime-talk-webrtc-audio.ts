import type { RealtimeTalkCallbacks } from "./realtime-talk-shared.ts";

export function attachRealtimeTalkRemoteAudio(params: {
  audio: HTMLAudioElement;
  stream: MediaStream;
  track: MediaStreamTrack;
  callbacks: RealtimeTalkCallbacks;
  isCurrent: () => boolean;
}): void {
  params.audio.srcObject = params.stream;
  const play = (reportError: boolean) => {
    if (!params.isCurrent()) {
      return;
    }
    void params.audio.play().catch((error: unknown) => {
      if (reportError && params.isCurrent()) {
        params.callbacks.onStatus?.(
          "error",
          `Realtime audio playback failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  };
  play(!params.track.muted);
  // iOS can deliver the remote track muted until media starts flowing.
  params.track.addEventListener("unmute", () => play(true), { once: true });
}
