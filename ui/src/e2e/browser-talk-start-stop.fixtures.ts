import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

export function videoTalkCatalog(activeProvider: "google" | "openai") {
  return {
    realtime: {
      activeProvider,
      providers: [{ id: activeProvider, label: activeProvider, supportsVideoFrames: true }],
    },
  };
}

export async function installTalkBrowserFixtures(page: Page) {
  await page.addInitScript(() => {
    type InputProcessor = {
      onaudioprocess:
        | ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void)
        | null;
    };
    const state = {
      audioContextsClosed: 0,
      tracksStopped: 0,
      constraints: [] as unknown[],
      inputProcessor: null as InputProcessor | null,
      meterLevel: 0,
    };
    const track = { stop: () => (state.tracksStopped += 1) };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "built-in", label: "Built-in Microphone" },
          { kind: "audioinput", deviceId: "usb", label: "USB Audio Interface" },
          { kind: "videoinput", deviceId: "camera", label: "Camera" },
        ],
        getUserMedia: async (constraints: unknown) => {
          state.constraints.push(constraints);
          return { getTracks: () => [track] };
        },
      },
    });

    class MockAudioContext {
      readonly currentTime = 0;
      readonly destination = {};
      readonly sampleRate: number;

      constructor(options?: { sampleRate?: number }) {
        this.sampleRate = options?.sampleRate ?? 24_000;
      }

      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }

      createGain() {
        return { connect() {}, disconnect() {}, gain: { value: 1 } };
      }

      createScriptProcessor() {
        const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
        state.inputProcessor = processor;
        return processor;
      }

      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          disconnect() {},
          getFloatTimeDomainData(samples: Float32Array) {
            samples.fill(state.meterLevel);
          },
        };
      }

      async close() {
        state.audioContextsClosed += 1;
      }
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: MockAudioContext,
    });
    Object.defineProperty(window, "openclawTalkE2eState", {
      configurable: true,
      value: state,
    });
  });
}

export async function installVideoTalkCameraFixture(
  page: Page,
  trackWindowKey: "openclawGeminiVideoTalkTracks" | "openclawVideoTalkTracks",
) {
  await page.addInitScript((windowKey) => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        let stream: MediaStream;
        if (constraints.video) {
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 480;
          const context = canvas.getContext("2d");
          if (!context) {
            throw new Error("Video Talk camera fixture could not create a canvas context");
          }
          stream = canvas.captureStream(0);
          const videoTrack = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
          let animationFrame = 0;
          const drawFrame = () => {
            if (videoTrack.readyState !== "live") {
              return;
            }
            context.fillStyle = "#335577";
            context.fillRect(0, 0, canvas.width, canvas.height);
            videoTrack.requestFrame();
            animationFrame = window.requestAnimationFrame(drawFrame);
          };
          drawFrame();
          window.addEventListener(
            "pagehide",
            () => {
              window.cancelAnimationFrame(animationFrame);
              videoTrack.stop();
            },
            { once: true },
          );
        } else {
          stream = await getUserMedia(constraints);
        }
        const trackWindow = window as unknown as Record<string, MediaStreamTrack[] | undefined>;
        trackWindow[windowKey] = [...(trackWindow[windowKey] ?? []), ...stream.getTracks()];
        return stream;
      },
    });
  }, trackWindowKey);
}

export async function captureComposerProof(page: Page, fileName: string) {
  const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "voice-controls");
  await mkdir(artifactDir, { recursive: true });
  await page
    .locator(".agent-chat__composer-shell")
    .screenshot({ path: path.join(artifactDir, fileName) });
}

export async function captureVideoTalkProof(page: Page, fileName: string) {
  const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "video-talk");
  await mkdir(artifactDir, { recursive: true });
  await page
    .locator(".agent-chat__composer-shell")
    .screenshot({ path: path.join(artifactDir, fileName) });
}

export async function installBlockedMicrophoneFixture(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [],
        getUserMedia: async () => {
          throw new DOMException("Permission denied", "NotAllowedError");
        },
      },
    });
  });
}

export async function installBlockedVideoTalkFixture(page: Page) {
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          if (constraints.video) {
            throw new DOMException("Permission denied", "NotAllowedError");
          }
          return getUserMedia(constraints);
        },
      },
    });
    class FakePeerConnection extends EventTarget {
      connectionState = "new";
      close() {
        this.connectionState = "closed";
      }
    }
    Object.defineProperty(window, "RTCPeerConnection", {
      configurable: true,
      value: FakePeerConnection,
    });
  });
}
