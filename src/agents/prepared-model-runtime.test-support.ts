type PreparedModelRuntimeTestApi = {
  resetPreparedModelRuntimeSnapshotsForTest(): void;
};

/** Clears prepared model owners when the production module is loaded in this test worker. */
export function resetPreparedModelRuntimeSnapshotsForTest(): void {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("afora.preparedModelRuntimeTestApi")
  ] as PreparedModelRuntimeTestApi | undefined;
  api?.resetPreparedModelRuntimeSnapshotsForTest();
}
