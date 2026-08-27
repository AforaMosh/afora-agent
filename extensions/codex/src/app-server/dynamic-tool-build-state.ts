type AforaCodingToolsFactory =
  (typeof import("afora-agent/plugin-sdk/agent-harness"))["createAforaCodingTools"];

/** Mutable dependency seam shared by dynamic-tool construction and its behavioral tests. */
export const dynamicToolBuildState: {
  aforaCodingToolsFactory?: AforaCodingToolsFactory;
} = {};
