/**
 * Focused runtime SDK subpath for native harness tool-surface routing.
 *
 * Keep tool-search and code-mode dependencies out of the lightweight harness
 * lifecycle facade used during plugin startup.
 */
import {
  createAgentHarnessToolSurfaceRuntimeCore,
  type AgentHarnessToolSurfaceRuntime as CoreAgentHarnessToolSurfaceRuntime,
} from "../agents/harness/tool-surface-bridge.js";

type AforaCodingToolsOptions = NonNullable<
  Parameters<typeof import("./agent-harness.js").createAforaCodingTools>[0]
>;

export type AgentHarnessToolSurfaceRuntime = Omit<
  CoreAgentHarnessToolSurfaceRuntime,
  "toolSearchCatalogExecutor" | "toolSearchCatalogRef"
> & {
  toolSearchCatalogExecutor: AforaCodingToolsOptions["toolSearchCatalogExecutor"];
  toolSearchCatalogRef: AforaCodingToolsOptions["toolSearchCatalogRef"];
};

export type AgentHarnessToolSurfaceRuntimeParams = Omit<
  Parameters<typeof createAgentHarnessToolSurfaceRuntimeCore>[0],
  "executeTool"
> & {
  executeTool: NonNullable<AforaCodingToolsOptions["toolSearchCatalogExecutor"]>;
};

export function createAgentHarnessToolSurfaceRuntime(
  params: AgentHarnessToolSurfaceRuntimeParams,
): AgentHarnessToolSurfaceRuntime {
  return createAgentHarnessToolSurfaceRuntimeCore(params);
}
