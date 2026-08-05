import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Creator-derived ceiling for runtime-native capabilities on scheduled turns. */
export type CronScheduledNativePolicy = {
  version: 1;
  mode: "inherit" | "disabled";
};

export function createCronScheduledNativePolicy(
  mode: CronScheduledNativePolicy["mode"],
): CronScheduledNativePolicy {
  return { version: 1, mode };
}

/** Accepts only the closed v1 policy; unknown input must be reauthorized or migrated. */
export function normalizeCronScheduledNativePolicy(
  value: unknown,
): CronScheduledNativePolicy | undefined {
  if (!isRecord(value) || value.version !== 1) {
    return undefined;
  }
  if (value.mode !== "inherit" && value.mode !== "disabled") {
    return undefined;
  }
  if (Object.keys(value).some((key) => key !== "version" && key !== "mode")) {
    return undefined;
  }
  return { version: 1, mode: value.mode };
}

/** Trusted/operator and shipped-job migration rule based on the durable OpenClaw cap. */
export function deriveCronScheduledNativePolicy(
  toolsAllow: readonly string[] | undefined,
): CronScheduledNativePolicy | undefined {
  if (!toolsAllow) {
    return undefined;
  }
  return createCronScheduledNativePolicy(
    toolsAllow.some((name) => name.trim() === "*") ? "inherit" : "disabled",
  );
}

/** Applies the persisted native ceiling to an otherwise configured agent runtime. */
export function resolveCronScheduledAgentRuntime(
  policy: CronScheduledNativePolicy | undefined,
  configuredRuntime: string | undefined,
): string | undefined {
  return policy?.mode === "disabled" ? "openclaw" : configuredRuntime;
}
