// Matrix plugin module implements monitor route test support behavior.
export {
  registerSessionBindingAdapter,
  testing,
} from "afora-agent/plugin-sdk/session-binding-runtime";
export { resolveAgentRoute } from "afora-agent/plugin-sdk/routing";
export {
  createTestRegistry,
  setActivePluginRegistry,
} from "afora-agent/plugin-sdk/plugin-test-runtime";
export type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
