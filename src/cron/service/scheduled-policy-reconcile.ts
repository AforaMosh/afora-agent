import {
  bindScheduledRuntimeAuthorityToToolsAllow,
  type ScheduledRuntimeAuthority,
} from "../scheduled-runtime-authority.js";
import {
  createTrustedCronScheduledToolPolicy,
  resolveCronScheduledToolPolicy,
  type CronScheduledToolPolicy,
} from "../scheduled-tool-policy.js";
import { cronJobUsesToolRuntime } from "../tools-allow.js";
import type { CronJob } from "../types.js";

export type CronScheduledPolicyInputs = {
  scheduledToolPolicy?: CronScheduledToolPolicy;
  scheduledRuntimeAuthority?: ScheduledRuntimeAuthority;
};

function stampScheduledToolPolicy(
  job: CronJob,
  scheduledToolPolicy: CronScheduledToolPolicy | undefined,
): void {
  if (!cronJobUsesToolRuntime(job) || job.payload.toolsAllow === undefined) {
    delete job.scheduledToolPolicy;
    return;
  }
  const policy = scheduledToolPolicy ?? createTrustedCronScheduledToolPolicy();
  if (
    policy.mode === "account" &&
    (job.owner?.sessionKey !== policy.ownerSessionKey ||
      job.owner?.accountId !== policy.ownerAccountId)
  ) {
    throw new Error("scheduled account policy must match the persisted job owner");
  }
  job.scheduledToolPolicy = structuredClone(policy);
}

function stampScheduledRuntimeAuthority(
  job: CronJob,
  authority: ScheduledRuntimeAuthority | undefined,
): void {
  if (
    !cronJobUsesToolRuntime(job) ||
    job.payload.toolsAllow === undefined ||
    job.payload.toolsAllowIsDefault !== true ||
    !authority
  ) {
    delete job.scheduledRuntimeAuthority;
    return;
  }
  job.scheduledRuntimeAuthority = bindScheduledRuntimeAuthorityToToolsAllow({
    authority: structuredClone(authority),
    toolsAllow: job.payload.toolsAllow,
  });
}

export function stampCronScheduledPolicies(job: CronJob, inputs: CronScheduledPolicyInputs): void {
  stampScheduledToolPolicy(job, inputs.scheduledToolPolicy);
  stampScheduledRuntimeAuthority(job, inputs.scheduledRuntimeAuthority);
}

export function reconcileCronScheduledPolicies(
  params: {
    job: CronJob;
    previouslyUsedToolRuntime: boolean;
    explicitlyMutatesToolsAllow: boolean;
  } & CronScheduledPolicyInputs,
): void {
  const { job } = params;
  if (!cronJobUsesToolRuntime(job) || job.payload.toolsAllow === undefined) {
    delete job.scheduledToolPolicy;
    delete job.scheduledRuntimeAuthority;
    return;
  }
  const current = resolveCronScheduledToolPolicy({
    toolsAllow: job.payload.toolsAllow,
    scheduledToolPolicy: job.scheduledToolPolicy,
    owner: job.owner,
  });
  if (current) {
    job.scheduledToolPolicy = current;
    if (params.explicitlyMutatesToolsAllow) {
      stampScheduledRuntimeAuthority(job, params.scheduledRuntimeAuthority);
    }
    return;
  }
  delete job.scheduledToolPolicy;
  if (params.explicitlyMutatesToolsAllow || !params.previouslyUsedToolRuntime) {
    stampCronScheduledPolicies(job, params);
  }
}
