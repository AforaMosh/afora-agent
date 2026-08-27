// Discord plugin module implements approval runtime behavior.
export {
  isChannelExecApprovalClientEnabledFromConfig,
  matchesApprovalRequestFilters,
  getExecApprovalReplyMetadata,
} from "afora-agent/plugin-sdk/approval-client-runtime";
export { resolveApprovalApprovers } from "afora-agent/plugin-sdk/approval-auth-runtime";
export { createApproverRestrictedNativeApprovalCapability } from "afora-agent/plugin-sdk/approval-delivery-runtime";
export {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
} from "afora-agent/plugin-sdk/approval-native-runtime";
