// Node discovery methods project paired and connected node state for callers.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateNodeDescribeParams,
  validateNodeListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listDevicePairing, resolveNodePairingState } from "../../infra/device-pairing.js";
import { listNodePairing } from "../../infra/node-pairing.js";
import type { NodeListNode } from "../../shared/node-list-types.js";
import { createKnownNodeCatalog, getKnownNode, listKnownNodes } from "../node-catalog.js";
import type { NodeSession } from "../node-registry.js";
import { nodeInvokePolicy } from "./nodes-policy.js";
import { respondInvalidParams, respondUnavailableOnThrow } from "./nodes.helpers.js";
import type { GatewayClient, GatewayRequestContext } from "./shared-types.js";
import type { GatewayRequestHandlers } from "./types.js";

function safeNodeReadProjection(
  node: NodeListNode,
  ownDeviceId: string | undefined,
): NodeListNode | null {
  if (!node.paired && !node.connected) {
    return null;
  }
  const {
    pendingRequestId,
    pendingDeclaredCaps: _pendingDeclaredCaps,
    pendingDeclaredCommands: _pendingDeclaredCommands,
    pendingDeclaredPermissions: _pendingDeclaredPermissions,
    ...safeNode
  } = node;
  // A read-scoped mobile client may guide its user to approve this phone, but must not expose
  // another node's approval target or any pending capability declaration.
  return node.nodeId === ownDeviceId && pendingRequestId
    ? { ...safeNode, pendingRequestId }
    : safeNode;
}

function nodeReadCallerDeviceId(client: GatewayClient | null): string | undefined {
  return normalizeOptionalString(client?.connect?.device?.id);
}

function isVisibleNode(node: NodeListNode | null): node is NodeListNode {
  return node !== null;
}

function listNodesForClient(params: {
  client: GatewayClient | null;
  pairedDevices: Awaited<ReturnType<typeof listDevicePairing>>["paired"];
  pairedNodes: Awaited<ReturnType<typeof listNodePairing>>["paired"];
  pendingNodes: Awaited<ReturnType<typeof listNodePairing>>["pending"];
  connectedNodes: readonly NodeSession[];
}): NodeListNode[] {
  const catalog = createKnownNodeCatalog({
    pairedDevices: params.pairedDevices,
    pairedNodes: params.pairedNodes,
    pendingNodes: params.pendingNodes,
    connectedNodes: params.connectedNodes,
  });
  const nodes = listKnownNodes(catalog);
  if (nodeInvokePolicy.canReadPendingNodePairing(params.client)) {
    return nodes;
  }
  const ownDeviceId = nodeReadCallerDeviceId(params.client);
  return nodes.map((node) => safeNodeReadProjection(node, ownDeviceId)).filter(isVisibleNode);
}

function listCurrentConnectedNodes(
  context: GatewayRequestContext,
  pairedDevices: Awaited<ReturnType<typeof listDevicePairing>>["paired"],
): NodeSession[] {
  const currentPairingStates = new Map<string, { identity: string; generation?: string }>();
  for (const device of pairedDevices) {
    const state = resolveNodePairingState(device);
    if (state) {
      currentPairingStates.set(state.identity.nodeId, {
        identity: state.identity.key,
        ...(state.generation ? { generation: state.generation.key } : {}),
      });
    }
  }
  return context.nodeRegistry.listConnectedForPairingStates(currentPairingStates);
}

export const nodeDiscoveryHandlers: GatewayRequestHandlers = {
  "node.list": async ({ params, respond, client, context }) => {
    if (!validateNodeListParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.list",
        validator: validateNodeListParams,
      });
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const [devicePairing, nodePairing] = await Promise.all([
        listDevicePairing(),
        listNodePairing(),
      ]);
      const connectedNodes = listCurrentConnectedNodes(context, devicePairing.paired);
      const nodes = listNodesForClient({
        client,
        pairedDevices: devicePairing.paired,
        pairedNodes: nodePairing.paired,
        pendingNodes: nodePairing.pending,
        connectedNodes,
      });
      const activeNodeId = context.nodeRegistry.getActiveNode(connectedNodes)?.nodeId;
      const nodesWithPresence = activeNodeId
        ? nodes.map((node) => (node.nodeId === activeNodeId ? { ...node, active: true } : node))
        : nodes;
      respond(true, { ts: Date.now(), activeNodeId, nodes: nodesWithPresence }, undefined);
    });
  },
  "node.describe": async ({ params, respond, client, context }) => {
    if (!validateNodeDescribeParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.describe",
        validator: validateNodeDescribeParams,
      });
      return;
    }
    const { nodeId } = params as { nodeId: string };
    const id = normalizeOptionalString(nodeId) ?? "";
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const [devicePairing, nodePairing] = await Promise.all([
        listDevicePairing(),
        listNodePairing(),
      ]);
      const connectedNodes = listCurrentConnectedNodes(context, devicePairing.paired);
      const catalog = createKnownNodeCatalog({
        pairedDevices: devicePairing.paired,
        pairedNodes: nodePairing.paired,
        pendingNodes: nodePairing.pending,
        connectedNodes,
      });
      const catalogNode = getKnownNode(catalog, id);
      const node =
        catalogNode && nodeInvokePolicy.canReadPendingNodePairing(client)
          ? catalogNode
          : catalogNode
            ? safeNodeReadProjection(catalogNode, nodeReadCallerDeviceId(client))
            : null;
      if (!node) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      respond(
        true,
        {
          ts: Date.now(),
          ...node,
          ...(context.nodeRegistry.getActiveNode(connectedNodes)?.nodeId === id
            ? { active: true }
            : {}),
        },
        undefined,
      );
    });
  },
};
