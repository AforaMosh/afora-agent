import type { AforaConfig } from "../../config/types.afora.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { ChannelSetupInput } from "./setup-input.js";

export type ChannelSetupAdapter<Input extends { name?: string } = ChannelSetupInput> = {
  resolveAccountId?: (params: { cfg: AforaConfig; accountId?: string; input?: Input }) => string;
  prepareAccountConfigInput?: (params: {
    cfg: AforaConfig;
    accountId: string;
    input: Input;
    runtime: RuntimeEnv;
  }) => Promise<Input> | Input;
  resolveBindingAccountId?: (params: {
    cfg: AforaConfig;
    agentId: string;
    accountId?: string;
  }) => string | undefined;
  applyAccountName?: (params: {
    cfg: AforaConfig;
    accountId: string;
    name?: string;
  }) => AforaConfig;
  applyAccountConfig: (params: {
    cfg: AforaConfig;
    accountId: string;
    input: Input;
  }) => AforaConfig;
  afterAccountConfigWritten?: (params: {
    previousCfg: AforaConfig;
    cfg: AforaConfig;
    accountId: string;
    input: Input;
    runtime: RuntimeEnv;
  }) => Promise<void> | void;
  validateInput?: (params: {
    cfg: AforaConfig;
    accountId: string;
    input: Input;
  }) => string | null;
  singleAccountKeysToMove?: readonly string[];
  namedAccountPromotionKeys?: readonly string[];
  resolveSingleAccountPromotionTarget?: (params: {
    channel: Record<string, unknown>;
  }) => string | undefined;
};
