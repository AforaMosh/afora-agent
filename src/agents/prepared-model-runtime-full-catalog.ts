import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";

const loadedFullModelCatalogAccessor = Symbol("openclaw.loadedFullModelCatalogAccessor");

type SnapshotWithLoadedFullModelCatalogAccessor = PreparedModelRuntimeSnapshot & {
  [loadedFullModelCatalogAccessor]?: () => ModelCatalogSnapshot | undefined;
};

/** Carries the lifecycle-owned full-catalog closure without widening the public snapshot shape. */
export function attachLoadedFullModelCatalogAccessor(
  snapshot: PreparedModelRuntimeSnapshot,
  accessor: () => ModelCatalogSnapshot | undefined,
): void {
  Object.defineProperty(snapshot, loadedFullModelCatalogAccessor, {
    configurable: false,
    enumerable: true,
    value: accessor,
    writable: false,
  });
}

/** Returns the full catalog only after this exact generation has already loaded it. */
export function getLoadedFullModelCatalog(
  snapshot: PreparedModelRuntimeSnapshot | undefined,
): ModelCatalogSnapshot | undefined {
  return (snapshot as SnapshotWithLoadedFullModelCatalogAccessor | undefined)?.[
    loadedFullModelCatalogAccessor
  ]?.();
}
