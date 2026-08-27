// Cloudflare Ai Gateway tests cover provider discovery.contract plugin behavior.
import { describeCloudflareAiGatewayProviderDiscoveryContract } from "afora-agent/plugin-sdk/provider-test-contracts";

describeCloudflareAiGatewayProviderDiscoveryContract(() => import("./index.js"));
