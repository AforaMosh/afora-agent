import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replaceConfigFile: vi.fn(),
  writeInstallRecords: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  replaceConfigFile: mocks.replaceConfigFile,
  resolveConfigWriteAfterWrite: (value?: unknown) => value ?? { mode: "auto" },
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  writePersistedInstalledPluginIndexInstallRecordsWithLease: mocks.writeInstallRecords,
}));

vi.mock("./plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (
    _options: unknown,
    run: (lease: { databasePath: string }) => Promise<unknown>,
  ) => await run({ databasePath: "/tmp/openclaw-plugin-index.sqlite" }),
}));

const { commitPluginInstallRecordsWithConfig } = await import("./install-record-commit.js");

it("checks publication authority immediately before the tentative index write", async () => {
  const commitPublication = vi.fn(() => {
    throw new Error("approval expired");
  });

  await expect(
    commitPluginInstallRecordsWithConfig({
      previousInstallRecords: {},
      nextInstallRecords: { demo: { source: "npm", spec: "demo@1.0.0" } },
      nextConfig: {},
      commitPublication,
    }),
  ).rejects.toThrow("approval expired");

  expect(commitPublication).toHaveBeenCalledOnce();
  expect(mocks.writeInstallRecords).not.toHaveBeenCalled();
  expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
});
