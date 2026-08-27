// Feishu plugin module implements audio preflight behavior.
import { transcribeFirstAudio as transcribeFirstAudioImpl } from "afora-agent/plugin-sdk/media-runtime";

type TranscribeFirstAudio = typeof import("afora-agent/plugin-sdk/media-runtime").transcribeFirstAudio;

export async function transcribeFirstAudio(
  ...args: Parameters<TranscribeFirstAudio>
): ReturnType<TranscribeFirstAudio> {
  return await transcribeFirstAudioImpl(...args);
}
