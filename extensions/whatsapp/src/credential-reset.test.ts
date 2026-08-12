// Whatsapp tests cover credential-reset lifecycle cleanup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  oauthDir: "",
  clearDirectPeerOwners: vi.fn<(accountId: string) => Promise<void>>(async () => {}),
}));

vi.mock("./auth-store.runtime.js", () => ({
  resolveOAuthDir: () => state.oauthDir,
}));

vi.mock("./direct-peer-owner.js", () => ({
  clearWhatsAppDirectPeerOwners: state.clearDirectPeerOwners,
}));

import { logoutWeb } from "./credential-reset.js";

describe("credential reset", () => {
  beforeEach(async () => {
    state.oauthDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-credential-reset-"));
    state.clearDirectPeerOwners.mockClear();
  });

  afterEach(async () => {
    await fs.rm(state.oauthDir, { recursive: true, force: true });
  });

  it("clears direct-peer ownership after managed credentials are deleted", async () => {
    const authDir = path.join(state.oauthDir, "whatsapp", "work");
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(path.join(authDir, "creds.json"), "{}", "utf8");

    await expect(
      logoutWeb({
        accountId: "work",
        authDir,
        runtime: { log: vi.fn() },
      } as never),
    ).resolves.toBe(true);
    await expect(fs.stat(authDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(state.clearDirectPeerOwners).toHaveBeenCalledOnce();
    expect(state.clearDirectPeerOwners).toHaveBeenCalledWith("work");
  });

  it("preserves direct-peer ownership when credential deletion is skipped", async () => {
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-external-auth-"));
    try {
      await fs.writeFile(path.join(authDir, "creds.json"), "{}", "utf8");

      await expect(
        logoutWeb({
          accountId: "work",
          authDir,
          runtime: { log: vi.fn() },
        } as never),
      ).resolves.toBe(false);
      expect(state.clearDirectPeerOwners).not.toHaveBeenCalled();
      await expect(fs.stat(path.join(authDir, "creds.json"))).resolves.toBeDefined();
    } finally {
      await fs.rm(authDir, { recursive: true, force: true });
    }
  });
});
