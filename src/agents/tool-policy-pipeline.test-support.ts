import "./tool-policy-pipeline.js";

type ToolPolicyWarningCacheTestApi = {
  resetToolPolicyWarningCacheForTest(): void;
};

function getTestApi(): ToolPolicyWarningCacheTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("afora.toolPolicyWarningCacheTestApi")
  ] as ToolPolicyWarningCacheTestApi;
}

export function resetToolPolicyWarningCacheForTest(): void {
  getTestApi().resetToolPolicyWarningCacheForTest();
}
