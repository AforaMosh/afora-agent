// Minimax tests cover provider discovery.contract plugin behavior.
import { describeMinimaxProviderDiscoveryContract } from "afora-agent/plugin-sdk/provider-test-contracts";

describeMinimaxProviderDiscoveryContract(() => import("./index.js"));
