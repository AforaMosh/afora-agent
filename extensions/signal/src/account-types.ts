// Signal plugin module implements account types behavior.
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";

type SignalChannelConfig = Exclude<NonNullable<AforaConfig["channels"]>["signal"], undefined>;

export type SignalAccountConfig = Omit<SignalChannelConfig, "accounts" | "defaultAccount">;

export type SignalTransportConfig = NonNullable<SignalChannelConfig["transport"]>;
