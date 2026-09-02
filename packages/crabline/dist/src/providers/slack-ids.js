export const SLACK_CHANNEL_ID_RULE = {
    example: "C1234567890",
    name: "Slack conversation id",
    pattern: /^[CDG][A-Z0-9]{2,}$/u,
};
export const SLACK_SEND_TARGET_ID_RULE = {
    example: "C1234567890",
    name: "Slack conversation or user id",
    pattern: /^[CDGUW][A-Z0-9]{2,}$/u,
};
export const SLACK_USER_ID_RULE = {
    example: "U1234567890",
    name: "Slack user id",
    pattern: /^[UW][A-Z0-9]{2,}$/u,
};
export const SLACK_TS_RULE = {
    example: "1700000000.000100",
    name: "Slack timestamp",
    pattern: /^\d{10}\.\d{6}$/u,
};
export function slackTargetKey(channel, threadTs) {
    return threadTs ? `${channel}:thread:${threadTs}` : channel;
}
