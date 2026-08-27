// Discord plugin module implements preview streaming behavior.
import {
  resolveChannelPreviewStreamMode,
  type StreamingMode,
} from "afora-agent/plugin-sdk/channel-outbound";

export function resolveDiscordPreviewStreamMode(
  params: {
    streaming?: unknown;
  } = {},
): StreamingMode {
  return resolveChannelPreviewStreamMode(params, "off");
}
