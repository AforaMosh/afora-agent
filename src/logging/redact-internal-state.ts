import type { AforaConfig } from "../config/types.afora.js";

type LoggingConfig = AforaConfig["logging"];
type InternalLoggingConfig = NonNullable<LoggingConfig> & {
  [fullContextToolPayloadRedaction]: true;
};

const fullContextToolPayloadRedaction = Symbol("full-context-tool-payload-redaction");

export const fullContextToolPayloadRedactionState = {
  mark(loggingConfig: LoggingConfig): InternalLoggingConfig {
    return {
      ...loggingConfig,
      [fullContextToolPayloadRedaction]: true,
    };
  },
  isMarked(loggingConfig: LoggingConfig): boolean {
    return Boolean(
      (loggingConfig as InternalLoggingConfig | undefined)?.[fullContextToolPayloadRedaction],
    );
  },
};
