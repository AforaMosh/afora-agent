// Connected-node surface methods refresh plugin capabilities and manage the
// foreground-action queue exposed to node clients.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  type ConnectParams,
  ErrorCodes,
  errorShape,
  validateNodeListParams,
  validateNodePendingAckParams,
  validateNodePluginToolsUpdateParams,
  validateNodeSkillsUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
} from "../../infra/node-pairing-state.js";
import { replaceRemoteNodeSkills } from "../../skills/runtime/remote-skills.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import {
  acknowledgePendingNodeActions,
  listPendingNodeActions,
  replacePendingNodeActionsForGeneration,
  type PendingNodeAction,
} from "../node-runtime-state.js";
import {
  hasAuthorizedClientPluginNodeCapabilityUrl,
  pluginNodeCapabilityScopedHostUrlsConflict,
  refreshClientPluginNodeCapability,
} from "../plugin-node-capability.js";
import { nodeInvokePolicy } from "./nodes-policy.js";
import {
  respondInvalidParams,
  respondNodePairingChanged,
  respondUnavailableOnThrow,
} from "./nodes.helpers.js";
import type { GatewayClient, RespondFn } from "./shared-types.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

function normalizePluginSurfaceRefreshParams(
  params: unknown,
): { surface: string; observedUrl?: string } | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const surface = normalizeOptionalString((params as { surface?: unknown }).surface);
  if (!surface) {
    return undefined;
  }
  const observedUrl = normalizeOptionalString((params as { observedUrl?: unknown }).observedUrl);
  return { surface, ...(observedUrl ? { observedUrl } : {}) };
}

function respondRefreshedPluginSurface(params: {
  surface: string;
  observedUrl?: string;
  client: GatewayClient | null;
  respond: RespondFn;
}) {
  const currentUrl = params.client?.pluginSurfaceUrls?.[params.surface];
  const capabilitySurface = params.client?.pluginNodeCapabilitySurfaces?.[params.surface] ?? {
    surface: params.surface,
  };
  if (
    params.client &&
    currentUrl &&
    params.observedUrl &&
    pluginNodeCapabilityScopedHostUrlsConflict(currentUrl, params.observedUrl) &&
    hasAuthorizedClientPluginNodeCapabilityUrl({
      client: params.client,
      surface: capabilitySurface,
      url: currentUrl,
    })
  ) {
    // A prior in-flight request already rotated this capability. Return its
    // result instead of invalidating it with a second rotation.
    params.respond(
      true,
      {
        surface: params.surface,
        pluginSurfaceUrls: { [params.surface]: currentUrl },
      },
      undefined,
    );
    return;
  }
  const refreshed = params.client
    ? refreshClientPluginNodeCapability({
        client: params.client,
        surface: capabilitySurface,
      })
    : undefined;
  if (!refreshed) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, `${params.surface} plugin surface unavailable`),
    );
    return;
  }
  params.respond(
    true,
    {
      surface: refreshed.surface,
      pluginSurfaceUrls: { [refreshed.surface]: refreshed.scopedUrl },
      expiresAtMs: refreshed.expiresAtMs,
    },
    undefined,
  );
}

const handlePluginSurfaceRefresh: GatewayRequestHandler = ({ params, respond, client }) => {
  const parsed = normalizePluginSurfaceRefreshParams(params);
  if (!parsed) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "surface required"));
    return;
  }
  respondRefreshedPluginSurface({
    surface: parsed.surface,
    observedUrl: parsed.observedUrl,
    client,
    respond,
  });
};

function resolveAllowedPendingNodeActions(params: {
  nodeId: string;
  pairingGeneration: string;
  client: { connect?: ConnectParams | null } | null;
  cfg: OpenClawConfig;
}): PendingNodeAction[] {
  const pending = listPendingNodeActions({
    nodeId: params.nodeId,
    pairingGeneration: params.pairingGeneration,
    ttlMs: nodeInvokePolicy.pendingActionTtlMs,
  });
  if (pending.length === 0) {
    return pending;
  }
  // Re-filter queued actions against the node's current declared commands and
  // allowlist; app upgrades or permission changes can make old actions unsafe.
  const connect = params.client?.connect;
  const declaredCommands = Array.isArray(connect?.commands) ? connect.commands : [];
  const allowlist = resolveNodeCommandAllowlist(params.cfg, {
    platform: connect?.client?.platform,
    deviceFamily: connect?.client?.deviceFamily,
    caps: connect?.caps,
    commands: declaredCommands,
  });
  const allowed = pending.filter((entry) => {
    const result = isNodeCommandAllowed({
      command: entry.command,
      declaredCommands,
      allowlist,
    });
    return result.ok;
  });
  if (allowed.length !== pending.length) {
    replacePendingNodeActionsForGeneration({
      nodeId: params.nodeId,
      pairingGeneration: params.pairingGeneration,
      replacement: allowed,
      ttlMs: nodeInvokePolicy.pendingActionTtlMs,
    });
  }
  return allowed;
}

function ackPendingNodeActions(
  nodeId: string,
  ids: string[],
  pairingGeneration: string,
): PendingNodeAction[] {
  if (ids.length === 0) {
    return listPendingNodeActions({
      nodeId,
      pairingGeneration,
      ttlMs: nodeInvokePolicy.pendingActionTtlMs,
    });
  }
  return acknowledgePendingNodeActions({
    nodeId,
    pairingGeneration,
    ids,
    ttlMs: nodeInvokePolicy.pendingActionTtlMs,
  });
}

export const nodeSurfaceHandlers: GatewayRequestHandlers = {
  "plugin.surface.refresh": handlePluginSurfaceRefresh,
  "node.pluginSurface.refresh": handlePluginSurfaceRefresh,
  "node.pluginTools.update": async ({ params, respond, client, context }) => {
    if (!validateNodePluginToolsUpdateParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pluginTools.update",
        validator: validateNodePluginToolsUpdateParams,
      });
      return;
    }
    const nodeId = normalizeOptionalString(
      client?.connect?.device?.id ?? client?.connect?.client?.id,
    );
    if (!nodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    const updated = context.nodeRegistry.updateNodePluginTools(
      nodeId,
      client?.connId,
      params.tools,
    );
    if (!updated) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
      return;
    }
    respond(true, { nodeId, tools: updated.nodePluginTools }, undefined);
  },
  "node.skills.update": async ({ params, respond, client, context }) => {
    if (!validateNodeSkillsUpdateParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.skills.update",
        validator: validateNodeSkillsUpdateParams,
      });
      return;
    }
    const nodeId = normalizeOptionalString(
      client?.connect?.device?.id ?? client?.connect?.client?.id,
    );
    if (!nodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    const updated = context.nodeRegistry.updateNodeSkills(nodeId, client?.connId, params.skills);
    if (!updated) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
      return;
    }
    replaceRemoteNodeSkills({
      nodeId,
      displayName: updated.displayName,
      skills: updated.nodeSkills,
    });
    respond(true, { nodeId, skills: updated.nodeSkills }, undefined);
  },
  "node.pending.pull": async ({ params, respond, client, context }) => {
    if (!validateNodeListParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pending.pull",
        validator: validateNodeListParams,
      });
      return;
    }
    const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
    const trimmedNodeId = normalizeOptionalString(nodeId) ?? "";
    if (!trimmedNodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }

    await respondUnavailableOnThrow(respond, async () => {
      const generation = await captureNodePairingGeneration(trimmedNodeId);
      if (!generation) {
        respondNodePairingChanged(respond);
        return;
      }
      const session = context.nodeRegistry.getForPairingGeneration(trimmedNodeId, generation.key);
      if (!session || session.connId !== client?.connId) {
        respondNodePairingChanged(respond);
        return;
      }
      const pending = resolveAllowedPendingNodeActions({
        nodeId: trimmedNodeId,
        pairingGeneration: generation.key,
        client,
        cfg: context.getRuntimeConfig(),
      });
      if (!(await isNodePairingGenerationCurrent(generation))) {
        respondNodePairingChanged(respond);
        return;
      }
      respond(
        true,
        {
          nodeId: trimmedNodeId,
          actions: pending.map((entry) => ({
            id: entry.id,
            command: entry.command,
            paramsJSON: entry.paramsJSON ?? null,
            enqueuedAtMs: entry.enqueuedAtMs,
          })),
        },
        undefined,
      );
    });
  },
  "node.pending.ack": async ({ params, respond, client, context }) => {
    if (!validateNodePendingAckParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pending.ack",
        validator: validateNodePendingAckParams,
      });
      return;
    }
    const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
    const trimmedNodeId = normalizeOptionalString(nodeId) ?? "";
    if (!trimmedNodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const generation = await captureNodePairingGeneration(trimmedNodeId);
      if (!generation) {
        respondNodePairingChanged(respond);
        return;
      }
      const session = context.nodeRegistry.getForPairingGeneration(trimmedNodeId, generation.key);
      if (!session || session.connId !== client?.connId) {
        respondNodePairingChanged(respond);
        return;
      }
      const ackIds = normalizeUniqueTrimmedStringList(params.ids);
      const remaining = ackPendingNodeActions(trimmedNodeId, ackIds, generation.key);
      if (!(await isNodePairingGenerationCurrent(generation))) {
        respondNodePairingChanged(respond);
        return;
      }
      respond(
        true,
        {
          nodeId: trimmedNodeId,
          ackedIds: ackIds,
          remainingCount: remaining.length,
        },
        undefined,
      );
    });
  },
};
