import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import {
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "../agents/model-selection-config.js";
import {
  buildModelAliasIndex,
  resolveHooksGmailModel,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import { configuredModelRouteNeedsCodex } from "../config/codex-plugin-diagnostics.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobEffectiveAgentId } from "./agent-id.js";
import { normalizeScheduledRuntimeAuthority } from "./scheduled-runtime-authority.js";
import type { CronJob } from "./types.js";

type CronRuntimeAuthorityStatus = "incomplete";

type RuntimeAuthorityStatusJob = Pick<
  CronJob,
  "agentId" | "sessionKey" | "payload" | "scheduledRuntimeAuthority"
>;
type RuntimeAuthorityAgentTurnPayload = Extract<CronJob["payload"], { kind: "agentTurn" }>;

function resolveConfiguredRoute(params: {
  cfg: OpenClawConfig;
  payload: RuntimeAuthorityAgentTurnPayload;
  agentId: string;
}) {
  const defaultRef = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: defaultRef.provider,
  });
  const resolveRaw = (raw: string) =>
    resolveModelRefFromString({
      cfg: params.cfg,
      raw,
      defaultProvider: defaultRef.provider,
      aliasIndex,
    })?.ref;

  let route = defaultRef;
  const subagentRaw = resolveSubagentConfiguredModelSelection({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (subagentRaw) {
    const resolved = resolveRaw(subagentRaw);
    if (!resolved) {
      return undefined;
    }
    route = resolved;
  }

  if (params.payload.externalContentSource === "gmail") {
    const gmailRaw = params.cfg.hooks?.gmail?.model?.trim();
    if (gmailRaw) {
      const resolved = resolveHooksGmailModel({
        cfg: params.cfg,
        defaultProvider: defaultRef.provider,
      });
      if (!resolved) {
        return undefined;
      }
      route = resolved;
    }
  }

  const payloadRaw = params.payload.model?.trim();
  if (payloadRaw) {
    const resolved = resolveRaw(payloadRaw);
    if (!resolved) {
      return undefined;
    }
    route = resolved;
  }
  return route;
}

/** Classifies upgrade recovery from the current configured primary route only. */
export function resolveConfiguredCronRuntimeAuthorityStatus(params: {
  cfg: OpenClawConfig;
  job: RuntimeAuthorityStatusJob;
  defaultAgentId?: string;
  env?: NodeJS.ProcessEnv;
}): CronRuntimeAuthorityStatus | undefined {
  if (
    params.job.payload.kind !== "agentTurn" ||
    params.job.payload.toolsAllowIsDefault !== true ||
    !Array.isArray(params.job.payload.toolsAllow) ||
    params.job.payload.toolsAllow.includes("*") ||
    normalizeScheduledRuntimeAuthority(params.job.scheduledRuntimeAuthority)
  ) {
    return undefined;
  }

  let agentId: string;
  try {
    agentId = resolveCronJobEffectiveAgentId(
      params.job,
      params.defaultAgentId ?? resolveDefaultAgentId(params.cfg),
    );
  } catch {
    return undefined;
  }
  if (!listAgentIds(params.cfg).includes(agentId)) {
    return undefined;
  }

  const route = resolveConfiguredRoute({ cfg: params.cfg, payload: params.job.payload, agentId });
  if (!route) {
    return undefined;
  }
  return configuredModelRouteNeedsCodex({
    cfg: params.cfg,
    env: params.env ?? process.env,
    agentId,
    route: { provider: route.provider, modelId: route.model },
  })
    ? "incomplete"
    : undefined;
}
