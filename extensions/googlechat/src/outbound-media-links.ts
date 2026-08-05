// Googlechat plugin module validates outbound media link fallbacks.
import { formatTextWithAttachmentLinks } from "openclaw/plugin-sdk/reply-payload";

const GOOGLE_CHAT_UNSUPPORTED_OUTBOUND_MEDIA_MESSAGE =
  "Google Chat outbound attachments require remote HTTP(S) URLs; native, local, and non-web attachments are not supported by this service-account channel.";
const GOOGLE_CHAT_URL_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

export function filterGoogleChatRemoteMediaUrls(mediaUrls: readonly string[]): string[] {
  return mediaUrls.flatMap((value) => {
    // WHATWG URL normalizes these characters, but the rendered link uses this value.
    if (GOOGLE_CHAT_URL_CONTROL_CHARACTERS.test(value)) {
      return [];
    }
    const mediaUrl = value.trim();
    try {
      const parsed = new URL(mediaUrl);
      if (
        /^https?:\/\//iu.test(mediaUrl) &&
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.hostname
      ) {
        return [mediaUrl];
      }
    } catch {
      // Unsupported URLs are omitted by the channel's text-fallback path.
    }
    return [];
  });
}

export function validateGoogleChatRemoteMediaUrls(
  mediaUrls: readonly string[],
  options?: { hasLocalMedia?: boolean },
): string[] {
  if (options?.hasLocalMedia) {
    throw new Error(GOOGLE_CHAT_UNSUPPORTED_OUTBOUND_MEDIA_MESSAGE);
  }

  const remoteMediaUrls = filterGoogleChatRemoteMediaUrls(mediaUrls);
  if (remoteMediaUrls.length !== mediaUrls.length) {
    throw new Error(GOOGLE_CHAT_UNSUPPORTED_OUTBOUND_MEDIA_MESSAGE);
  }
  return remoteMediaUrls;
}

export function formatGoogleChatTextWithMediaLinks(params: {
  text?: string;
  mediaUrls: readonly string[];
  hasLocalMedia?: boolean;
}): string {
  return formatTextWithAttachmentLinks(
    params.text,
    validateGoogleChatRemoteMediaUrls(params.mediaUrls, {
      hasLocalMedia: params.hasLocalMedia,
    }),
  );
}
