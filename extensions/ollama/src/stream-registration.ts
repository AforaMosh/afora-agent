import type { StreamFn } from "afora-agent/plugin-sdk/agent-core";
import { createLazyRuntimeModule } from "afora-agent/plugin-sdk/lazy-runtime";

const loadOllamaStreamRuntime = createLazyRuntimeModule(() => import("./stream.runtime.js"));

export function createLazyConfiguredOllamaStreamFn(params: {
  model: { baseUrl?: string; headers?: unknown };
  providerBaseUrl?: string;
}): StreamFn {
  const streamFnPromise = loadOllamaStreamRuntime().then((runtime) =>
    runtime.createConfiguredOllamaStreamFn(params),
  );
  return async (...args) => {
    const streamFn = await streamFnPromise;
    return streamFn(...args);
  };
}
