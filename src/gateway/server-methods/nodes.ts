// Node gateway method facade. Domain modules keep pairing, discovery, surface,
// invocation, wake, and event responsibilities independently reviewable.
import { nodeDiscoveryHandlers } from "./nodes-discovery.js";
import { nodeEventHandlers } from "./nodes-events.js";
import { nodeInvokeHandlers } from "./nodes-invoke.js";
import { nodePairingHandlers } from "./nodes-pairing.js";
import { nodeSurfaceHandlers } from "./nodes-surfaces.js";
import type { GatewayRequestHandlers } from "./types.js";

export {
  maybeSendNodeWakeNudge,
  maybeWakeNodeWithApns,
  waitForNodeReconnect,
} from "./nodes-wake.js";

export const nodeHandlers: GatewayRequestHandlers = {
  ...nodePairingHandlers,
  ...nodeDiscoveryHandlers,
  ...nodeSurfaceHandlers,
  ...nodeInvokeHandlers,
  ...nodeEventHandlers,
};
