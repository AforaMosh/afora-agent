// Telegram plugin module implements auto topic label behavior.
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import { generateConversationLabel } from "afora-agent/plugin-sdk/reply-dispatch-runtime";
export { resolveAutoTopicLabelConfig } from "./auto-topic-label-config.js";

export async function generateTelegramTopicLabel(params: {
  userMessage: string;
  prompt: string;
  cfg: AforaConfig;
  agentId?: string;
  agentDir?: string;
}): Promise<string | null> {
  return await generateConversationLabel({
    ...params,
    maxLength: 128,
  });
}
