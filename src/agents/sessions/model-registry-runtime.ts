import {
  createApiRegistry,
  createLlmRuntime,
  type ApiRegistry,
  type LlmRuntime,
} from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import "../ai-transport-runtime-host.js";
import { bindStreamLlmRuntime } from "../../llm/model-runtime-binding.js";

type ModelRegistryRuntime = {
  apiRegistry: ApiRegistry;
  llmRuntime: LlmRuntime;
};

const modelRegistryRuntimes = new WeakMap<object, ModelRegistryRuntime>();

function resetApiRegistry(runtime: ModelRegistryRuntime): void {
  runtime.apiRegistry.clearApiProviders();
  registerBuiltInApiProviders(runtime.apiRegistry);
}

/** Creates the runtime facts owned by one model-registry lifecycle. */
export function initializeModelRegistryRuntime<TOwner extends object>(owner: TOwner): void {
  const apiRegistry = createApiRegistry();
  const llmRuntime = createLlmRuntime(apiRegistry);
  const runtime = { apiRegistry, llmRuntime };
  bindStreamLlmRuntime(llmRuntime.streamSimple, llmRuntime);
  resetApiRegistry(runtime);
  modelRegistryRuntimes.set(owner, runtime);
}

/** Returns the prepared runtime facts for one model-registry lifecycle. */
export function getModelRegistryRuntime<TOwner extends object>(
  owner: TOwner,
): ModelRegistryRuntime {
  const runtime = modelRegistryRuntimes.get(owner);
  if (!runtime) {
    throw new Error("Model registry runtime is not initialized");
  }
  return runtime;
}

export function resetModelRegistryRuntime<TOwner extends object>(owner: TOwner): void {
  resetApiRegistry(getModelRegistryRuntime(owner));
}
