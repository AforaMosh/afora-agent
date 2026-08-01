import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "../agents/model-selection.js";
import { resolveChannelModelOverride } from "../channels/model-overrides.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionDeliveryChannel, sessionDeliveryOrigin } from "../utils/delivery-context.shared.js";

export function resolveStatusChannelModel(params: {
  cfg?: OpenClawConfig;
  entry?: SessionEntry;
  parentSessionKey?: string;
  defaultProvider?: string;
}): { provider: string; model: string } | undefined {
  if (!params.cfg || !params.entry) {
    return undefined;
  }
  if (
    normalizeOptionalString(params.entry.modelOverride) ||
    normalizeOptionalString(params.entry.providerOverride)
  ) {
    return undefined;
  }
  const origin = sessionDeliveryOrigin(params.entry);
  const channelOverride = resolveChannelModelOverride({
    cfg: params.cfg,
    channel: sessionDeliveryChannel(params.entry),
    groupId: params.entry.groupId,
    groupChatType: params.entry.chatType ?? origin?.chatType,
    groupChannel: params.entry.groupChannel,
    groupSubject: params.entry.subject,
    parentSessionKey: params.parentSessionKey,
    directUserIds: [origin?.nativeDirectUserId, origin?.from, origin?.to],
  });
  if (!channelOverride) {
    return undefined;
  }
  const defaultProvider = params.defaultProvider ?? DEFAULT_PROVIDER;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider,
    allowPluginNormalization: false,
  });
  return resolveModelRefFromString({
    raw: channelOverride.model,
    defaultProvider,
    aliasIndex,
    allowPluginNormalization: false,
  })?.ref;
}
