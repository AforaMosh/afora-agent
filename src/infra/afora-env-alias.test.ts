// The env alias is the shim that lets a tenant provisioned before the rename keep booting: it
// is read by normalizeEnv() at startup and by nothing else, so a break here is silent and
// total. It had no test at all, which is exactly the code that rots (see DB-COMPAT).
import { afterEach, describe, expect, it, vi } from "vitest";

// warnedLegacy is module state and only lets the first call warn per process, so every case
// that cares about the warning needs its own module instance.
async function freshApply(): Promise<(env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv> {
  vi.resetModules();
  return (await import("./afora-env-alias.js")).applyAforaEnvAliases;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyAforaEnvAliases", () => {
  it("fills a missing canonical name from its legacy twin", async () => {
    const apply = await freshApply();
    const env = apply({ OPENCLAW_STATE_DIR: "/home/t/.openclaw-u1" });
    expect(env.AFORA_STATE_DIR).toBe("/home/t/.openclaw-u1");
  });

  it("fills a missing legacy name from its canonical twin, for children that still read it", async () => {
    const apply = await freshApply();
    const env = apply({ AFORA_PROFILE: "u1" });
    expect(env.OPENCLAW_PROFILE).toBe("u1");
  });

  it("lets an explicitly set canonical value win over its legacy twin", async () => {
    const apply = await freshApply();
    const env = apply({ AFORA_STATE_DIR: "/new", OPENCLAW_STATE_DIR: "/old" });
    expect(env.AFORA_STATE_DIR).toBe("/new");
    expect(env.OPENCLAW_STATE_DIR).toBe("/old");
  });

  it("leaves an unrelated variable alone and invents no third spelling", async () => {
    const apply = await freshApply();
    const env = apply({ HOME: "/home/t", OPENCLAW_STATE_DIR: "/s" });
    expect(Object.keys(env).toSorted()).toEqual(["AFORA_STATE_DIR", "HOME", "OPENCLAW_STATE_DIR"]);
  });

  // The ordering trap the comment in the source records, and it has teeth: `warnedLegacy` is
  // set on the FIRST legacy key seen whether or not anything was printed, so there is exactly
  // one chance to warn. If that first key is not the log level itself, AFORA_LOG_LEVEL has not
  // been filled yet and only the direct read of the legacy key still sees the debug signal.
  // Enumerated rather than table-driven so the failure names the order that broke.
  it.each([
    { order: "log level first", env: { OPENCLAW_LOG_LEVEL: "debug", OPENCLAW_STATE_DIR: "/s" } },
    { order: "log level last", env: { OPENCLAW_STATE_DIR: "/s", OPENCLAW_LOG_LEVEL: "debug" } },
  ])("warns for an operator who set only the legacy log level ($order)", async ({ env }) => {
    const apply = await freshApply();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    apply({ ...env });
    expect(errors).toHaveBeenCalledTimes(1);
  });

  // afora-compat: the warning names the OPENCLAW_* prefix deliberately (D8). An operator has to
  // be told WHICH of their variables is the legacy one, so this pins the name in, not out.
  it("names the legacy prefix and the canonical one, and says the old names still work", async () => {
    const apply = await freshApply();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    apply({ DEBUG: "1", OPENCLAW_STATE_DIR: "/s" });
    const message = String(errors.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("OPENCLAW_*");
    expect(message).toContain("AFORA_*");
    expect(message).toContain("they still work");
    expect(message.startsWith("afora:")).toBe(true);
  });

  it("warns once, not once per aliased variable", async () => {
    const apply = await freshApply();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    apply({ DEBUG: "1", OPENCLAW_STATE_DIR: "/s", OPENCLAW_PROFILE: "u1", OPENCLAW_PORT: "1" });
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("stays silent without a debug signal, and when the alias debug is switched off", async () => {
    for (const env of [
      { OPENCLAW_STATE_DIR: "/s" },
      { DEBUG: "1", OPENCLAW_STATE_DIR: "/s", AFORA_DEBUG_ENV_ALIAS: "0" },
    ]) {
      const apply = await freshApply();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      apply({ ...env });
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    }
  });
});
