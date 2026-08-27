// Runtime task types describe plugin task runtime config and invocation options.
import type { AforaConfig } from "../../config/types.afora.js";
import type { TaskDeliveryState } from "../../tasks/task-registry.types.js";
import type { AforaPluginToolContext } from "../tool-types.js";
import type { PluginRuntimeTaskFlow } from "./runtime-taskflow.types.js";
import type {
  TaskFlowDetail,
  TaskFlowView,
  TaskRunAggregateSummary,
  TaskRunCancelResult,
  TaskRunDetail,
  TaskRunView,
} from "./task-domain-types.js";
export type { TaskFlowDetail, TaskRunCancelResult } from "./task-domain-types.js";

export type BoundTaskRunsRuntime = {
  readonly sessionKey: string;
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  get: (taskId: string) => TaskRunDetail | undefined;
  list: () => TaskRunView[];
  findLatest: () => TaskRunDetail | undefined;
  resolve: (token: string) => TaskRunDetail | undefined;
  cancel: (params: { taskId: string; cfg: AforaConfig }) => Promise<TaskRunCancelResult>;
};

export type PluginRuntimeTaskRuns = {
  bindSession: (params: {
    sessionKey: string;
    agentId?: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskRunsRuntime;
  fromToolContext: (
    ctx: Pick<AforaPluginToolContext, "sessionKey" | "agentId" | "deliveryContext">,
  ) => BoundTaskRunsRuntime;
};

export type BoundTaskFlowsRuntime = {
  readonly sessionKey: string;
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  get: (flowId: string) => TaskFlowDetail | undefined;
  list: () => TaskFlowView[];
  findLatest: () => TaskFlowDetail | undefined;
  resolve: (token: string) => TaskFlowDetail | undefined;
  getTaskSummary: (flowId: string) => TaskRunAggregateSummary | undefined;
};

export type PluginRuntimeTaskFlows = {
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskFlowsRuntime;
  fromToolContext: (
    ctx: Pick<AforaPluginToolContext, "sessionKey" | "deliveryContext">,
  ) => BoundTaskFlowsRuntime;
};

export type PluginRuntimeTasks = {
  runs: PluginRuntimeTaskRuns;
  flows: PluginRuntimeTaskFlows;
  managedFlows: PluginRuntimeTaskFlow;
};
