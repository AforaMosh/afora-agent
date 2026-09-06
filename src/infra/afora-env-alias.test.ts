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

  // The mirror is bookkeeping, and bookkeeping must not outlive what it shadows. Every
  // AFORA_* now has an OPENCLAW_* twin, so code that drops a setting by deleting the
  // canonical name leaves the twin behind, and the next pass reads it straight back in.
  // The gateway restart path drops settings exactly that way between passes.
  it("does not resurrect a canonical value the caller deleted, from the twin it mirrored", async () => {
    const apply = await freshApply();
    const env: NodeJS.ProcessEnv = { AFORA_STATE_DIR: "/selected" };
    apply(env);
    expect(env.OPENCLAW_STATE_DIR).toBe("/selected");

    delete env.AFORA_STATE_DIR;
    apply(env);
    expect(env.AFORA_STATE_DIR).toBeUndefined();
    expect(env.OPENCLAW_STATE_DIR).toBeUndefined();
  });

  // The other half of the same rule: a twin the OPERATOR exported is an input, not our
  // shadow, so dropping the canonical name must still read it back. That is the dual-read
  // D5 asks for, and it is what stops the fix above from quietly deleting a tenant's export.
  it("still reads back a legacy name the operator exported, after the canonical is deleted", async () => {
    const apply = await freshApply();
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "/exported" };
    apply(env);
    expect(env.AFORA_STATE_DIR).toBe("/exported");

    delete env.AFORA_STATE_DIR;
    apply(env);
    expect(env.AFORA_STATE_DIR).toBe("/exported");
    expect(env.OPENCLAW_STATE_DIR).toBe("/exported");
  });

  // A stale twin is as wrong as a resurrected one, in the other direction: a child that
  // reads the legacy name would be handed the value the canonical one used to have.
  it("refreshes a twin it wrote when the canonical value moves on, and never one it did not", async () => {
    const apply = await freshApply();
    const env: NodeJS.ProcessEnv = { AFORA_GATEWAY_TOKEN: "old" };
    apply(env);
    env.AFORA_GATEWAY_TOKEN = "rotated";
    apply(env);
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("rotated");

    const operator: NodeJS.ProcessEnv = { AFORA_STATE_DIR: "/new", OPENCLAW_STATE_DIR: "/theirs" };
    apply(operator);
    expect(operator.OPENCLAW_STATE_DIR).toBe("/theirs");
  });
});
