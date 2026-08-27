import type { AforaConfig } from "../config/types.afora.js";
import { fullContextToolPayloadRedactionState } from "./redact-internal-state.js";

type LoggingConfig = AforaConfig["logging"];

export function withFullContextToolPayloadRedaction(loggingConfig: LoggingConfig): LoggingConfig {
  return fullContextToolPayloadRedactionState.mark(loggingConfig);
}
