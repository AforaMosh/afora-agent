import type { AforaConfig } from "../config/types.afora.js";
import { mergeProcessEnv } from "./process-env.js";
import type { UpdateChannel } from "./update-channels.js";

export const POST_CORE_UPDATE_ENV = "AFORA_UPDATE_POST_CORE";
export const POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV = "AFORA_UPDATE_POST_CORE_REQUESTED_CHANNEL";
export const POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV =
  "AFORA_UPDATE_POST_CORE_SOURCE_CONFIG_PATH";

export function buildPostCoreHandoffEnv(params: {
  baseEnv: NodeJS.ProcessEnv;
  compatHostVersion?: string | null;
  requestedChannel?: UpdateChannel | null;
  sourceConfigPath?: string;
}): NodeJS.ProcessEnv {
  return mergeProcessEnv([
    params.baseEnv,
    {
      AFORA_COMPATIBILITY_HOST_VERSION: params.compatHostVersion || undefined,
      [POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV]: params.requestedChannel || undefined,
      [POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV]: params.sourceConfigPath || undefined,
    },
  ]);
}

export type PreUpdateConfigRestoreInput = {
  sourceConfig: AforaConfig;
  authoredConfig: AforaConfig;
};
