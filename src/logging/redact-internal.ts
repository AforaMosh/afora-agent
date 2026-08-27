import type { AforaConfig } from "../config/types.afora.js";
import { fullContextToolPayloadRedactionState } from "./redact-internal-state.js";

type LoggingConfig = AforaConfig["logging"];

export function isFullContextToolPayloadRedaction(loggingConfig: LoggingConfig): boolean {
  return fullContextToolPayloadRedactionState.isMarked(loggingConfig);
}
