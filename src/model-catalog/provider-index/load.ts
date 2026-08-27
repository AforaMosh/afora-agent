// Provider-index loader normalizes bundled installable-provider metadata and falls back to an empty index.
import { normalizeAforaProviderIndex } from "./normalize.js";
import { AFORA_PROVIDER_INDEX } from "./afora-provider-index.js";
import type { AforaProviderIndex } from "./types.js";

// Load the bundled provider index through the normalizer. Invalid generated or
// caller-supplied data falls back to an empty v1 index instead of leaking shape.
export function loadAforaProviderIndex(
  source: unknown = AFORA_PROVIDER_INDEX,
): AforaProviderIndex {
  return normalizeAforaProviderIndex(source) ?? { version: 1, providers: {} };
}
