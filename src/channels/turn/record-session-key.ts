import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { ChannelTurnRecordOptions } from "./types.js";

type RecordableChannelTurn = {
  ctxPayload: FinalizedMsgContext;
  record?: ChannelTurnRecordOptions;
  routeSessionKey: string;
};

/** Resolves the one key used for both session metadata and transcript context. */
export function resolveRecordSessionKey(params: RecordableChannelTurn): string {
  const explicitSessionKey = params.record?.sessionKey;
  if (explicitSessionKey === undefined) {
    return params.ctxPayload.SessionKey ?? params.routeSessionKey;
  }
  const normalizedSessionKey = explicitSessionKey.trim();
  if (!normalizedSessionKey) {
    throw new Error("Channel turn record.sessionKey must be non-empty.");
  }
  if (normalizedSessionKey !== explicitSessionKey) {
    throw new Error("Channel turn record.sessionKey must not include surrounding whitespace.");
  }
  return explicitSessionKey;
}
