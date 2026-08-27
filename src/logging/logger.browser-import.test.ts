// Logger browser import tests cover safe import behavior in browser-like runtimes.
import { importFreshModule } from "afora-agent/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

type LoggerModule = typeof import("./logger.js");

const originalGetBuiltinModule = (
  process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }
).getBuiltinModule;

async function importBrowserSafeLogger(params?: {
  resolvePreferredAforaTmpDir?: ReturnType<typeof vi.fn>;
}): Promise<{
  module: LoggerModule;
  resolvePreferredAforaTmpDir: ReturnType<typeof vi.fn>;
}> {
  const resolvePreferredAforaTmpDir =
    params?.resolvePreferredAforaTmpDir ??
    vi.fn(() => {
      throw new Error("resolvePreferredAforaTmpDir should not run during browser-safe import");
    });

  vi.doMock("../infra/tmp-afora-dir.js", async () => {
    const actual = await vi.importActual<typeof import("../infra/tmp-afora-dir.js")>(
      "../infra/tmp-afora-dir.js",
    );
    return {
      ...actual,
      resolvePreferredAforaTmpDir,
    };
  });

  Object.defineProperty(process, "getBuiltinModule", {
    configurable: true,
    value: undefined,
  });

  const module = await importFreshModule<LoggerModule>(
    import.meta.url,
    "./logger.js?scope=browser-safe",
  );
  return { module, resolvePreferredAforaTmpDir };
}

describe("logging/logger browser-safe import", () => {
  afterEach(() => {
    vi.doUnmock("../infra/tmp-afora-dir.js");
    Object.defineProperty(process, "getBuiltinModule", {
      configurable: true,
      value: originalGetBuiltinModule,
    });
  });

  it("does not resolve the preferred temp dir at import time when node fs is unavailable", async () => {
    const { module, resolvePreferredAforaTmpDir } = await importBrowserSafeLogger();

    expect(resolvePreferredAforaTmpDir).not.toHaveBeenCalled();
    expect(module.DEFAULT_LOG_DIR).toBe("/tmp/afora");
    expect(module.DEFAULT_LOG_FILE).toBe("/tmp/AforaMosh/afora-agent.log");
  });

  it("disables file logging when imported in a browser-like environment", async () => {
    const { module, resolvePreferredAforaTmpDir } = await importBrowserSafeLogger();

    expect(module.getResolvedLoggerSettings()).toStrictEqual({
      level: "silent",
      file: "/tmp/AforaMosh/afora-agent.log",
      maxFileBytes: 100 * 1024 * 1024,
    });
    expect(module.isFileLogLevelEnabled("info")).toBe(false);
    expect(module.getLogger().info("browser-safe")).toBeUndefined();
    expect(resolvePreferredAforaTmpDir).not.toHaveBeenCalled();
  });
});
