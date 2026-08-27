import "./ai-transport-runtime-host.js";
import "@afora/ai/transports";

const responsesTesting = globalThis.aforaOpenAIResponsesTransportTestApi;
if (!responsesTesting) {
  throw new Error("OpenAI transport test APIs are unavailable outside test mode");
}

type OpenAIResponsesTransportTestApi = NonNullable<
  typeof globalThis.aforaOpenAIResponsesTransportTestApi
>;

// Keep declaration emit on the public test-API names instead of transport internals.
export const testing: OpenAIResponsesTransportTestApi = responsesTesting;
