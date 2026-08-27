// Shared provider dispatch type contracts for reply runtime execution.
import type { AforaConfig } from "../../config/types.afora.js";
import type { PluginCommandReplyOptions } from "../../plugins/plugin-command-dispatch-contract.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { FinalizedMsgContext, MsgContext } from "../templating.js";
import type { DispatchFromConfigResult } from "./dispatch-from-config.types.js";
import type { GetReplyFromConfig } from "./get-reply.types.js";
import type {
  ReplyDispatcherOptions,
  ReplyDispatcherWithTypingOptions,
} from "./reply-dispatcher.js";

type DispatchReplyContext = MsgContext | FinalizedMsgContext;
type DispatchReplyOptions = Omit<GetReplyOptions, "onBlockReply"> & PluginCommandReplyOptions;

/** Buffered block dispatcher entry point used by provider reply flows. */
export type DispatchReplyWithBufferedBlockDispatcher = (params: {
  ctx: DispatchReplyContext;
  cfg: AforaConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  toolsAllow?: string[];
  replyOptions?: DispatchReplyOptions;
  replyResolver?: GetReplyFromConfig;
}) => Promise<DispatchFromConfigResult>;

/** Plain dispatcher entry point used when block buffering is not needed. */
export type DispatchReplyWithDispatcher = (params: {
  ctx: DispatchReplyContext;
  cfg: AforaConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  toolsAllow?: string[];
  replyOptions?: DispatchReplyOptions;
  replyResolver?: GetReplyFromConfig;
}) => Promise<DispatchFromConfigResult>;
