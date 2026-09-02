import type { NativeIdRule } from "./native-ids.js";
export declare const SLACK_CHANNEL_ID_RULE: NativeIdRule;
export declare const SLACK_SEND_TARGET_ID_RULE: NativeIdRule;
export declare const SLACK_USER_ID_RULE: NativeIdRule;
export declare const SLACK_TS_RULE: NativeIdRule;
export declare function slackTargetKey(channel: string, threadTs?: string): string;
