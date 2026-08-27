// Qwen tests cover provider discovery.contract plugin behavior.
import { describeModelStudioProviderDiscoveryContract } from "afora-agent/plugin-sdk/provider-test-contracts";

describeModelStudioProviderDiscoveryContract(() => import("./index.js"));
