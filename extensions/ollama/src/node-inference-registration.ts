import { createLazyRuntimeModule } from "afora-agent/plugin-sdk/lazy-runtime";
import type {
  AnyAgentTool,
  AforaPluginApi,
  AforaPluginNodeHostCommand,
  AforaPluginNodeInvokePolicy,
} from "afora-agent/plugin-sdk/plugin-entry";
import {
  OLLAMA_CHAT_COMMAND,
  OLLAMA_MODELS_COMMAND,
  OLLAMA_NODE_INFERENCE_CAPABILITY,
  OLLAMA_NODE_INFERENCE_COMMANDS,
  OLLAMA_NODE_INFERENCE_DEFAULT_PLATFORMS,
  ollamaNodeInferenceToolDefinition,
} from "./node-inference-contract.js";

const loadOllamaNodeInference = createLazyRuntimeModule(() => import("./node-inference.js"));

function createLazyNodeHostCommand(
  command: (typeof OLLAMA_NODE_INFERENCE_COMMANDS)[number],
): AforaPluginNodeHostCommand {
  let runtimeCommandPromise: Promise<AforaPluginNodeHostCommand> | undefined;
  const loadRuntimeCommand = () =>
    (runtimeCommandPromise ??= loadOllamaNodeInference().then((runtime) => {
      const runtimeCommand = runtime
        .createOllamaNodeHostCommands()
        .find((candidate) => candidate.command === command);
      if (!runtimeCommand) {
        throw new Error(`Ollama node inference runtime missing ${command}`);
      }
      return runtimeCommand;
    }));
  return {
    command,
    cap: OLLAMA_NODE_INFERENCE_CAPABILITY,
    handle: async (paramsJSON, io, context) => {
      const runtimeCommand = await loadRuntimeCommand();
      return await runtimeCommand.handle(paramsJSON, io, context);
    },
  };
}

export function createLazyOllamaNodeHostCommands(): AforaPluginNodeHostCommand[] {
  return [
    createLazyNodeHostCommand(OLLAMA_MODELS_COMMAND),
    createLazyNodeHostCommand(OLLAMA_CHAT_COMMAND),
  ];
}

export function createOllamaNodeInvokePolicy(): AforaPluginNodeInvokePolicy {
  return {
    commands: [...OLLAMA_NODE_INFERENCE_COMMANDS],
    defaultPlatforms: [...OLLAMA_NODE_INFERENCE_DEFAULT_PLATFORMS],
    handle: async (ctx) => await ctx.invokeNode(),
  };
}

export function createLazyOllamaNodeInferenceTool(api: AforaPluginApi): AnyAgentTool {
  let toolPromise: Promise<AnyAgentTool> | undefined;
  const loadTool = () =>
    (toolPromise ??= loadOllamaNodeInference().then((runtime) =>
      runtime.createOllamaNodeInferenceTool(api),
    ));
  return {
    ...ollamaNodeInferenceToolDefinition,
    execute: async (...args) => {
      const tool = await loadTool();
      return await tool.execute(...args);
    },
  };
}
