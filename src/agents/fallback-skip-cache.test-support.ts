type FallbackSkipCacheState = {
  buckets: Map<string, Map<string, unknown>>;
  lastGlobalPruneAtMs: number;
};

function getFallbackSkipCacheGlobals() {
  return globalThis as typeof globalThis & {
    aforaFallbackSkipCache?: Map<string, Map<string, unknown>>;
    aforaFallbackSkipCacheState?: FallbackSkipCacheState;
  };
}

export function resetFallbackSkipCacheForTest(): void {
  const globals = getFallbackSkipCacheGlobals();
  globals.aforaFallbackSkipCache?.clear();
  globals.aforaFallbackSkipCacheState?.buckets.clear();
  if (globals.aforaFallbackSkipCacheState) {
    globals.aforaFallbackSkipCacheState.lastGlobalPruneAtMs = 0;
  }
}

export function listFallbackSkipCacheSessionIdsForTest(): string[] {
  const globals = getFallbackSkipCacheGlobals();
  return [...(globals.aforaFallbackSkipCacheState?.buckets.keys() ?? [])];
}
