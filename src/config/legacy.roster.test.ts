import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "./config.js";

describe("agent roster source contract", () => {
  it("keeps a rosterless source document unchanged and materializes runtime main", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const raw = `// operator comment\n{ gateway: { mode: "local" } }\n`;
      await fs.writeFile(configPath, raw);
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.valid).toBe(true);
      expect(snapshot.sourceConfig.agents?.entries).toBeUndefined();
      expect(snapshot.runtimeConfig.agents?.entries).toEqual({ main: { default: true } });
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    });
  });

  it("materializes runtime main without adding it to an absent source file", async () => {
    await withTempHome(async () => {
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.exists).toBe(false);
      expect(snapshot.sourceConfig.agents?.entries).toBeUndefined();
      expect(snapshot.runtimeConfig.agents?.entries).toEqual({ main: { default: true } });
      expect(snapshot.config.agents?.entries).toEqual({ main: { default: true } });
    });
  });

  it("rejects a persisted legacy list until doctor repairs it", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ agents: { list: [{ id: "ops", default: true }] } }),
      );
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(snapshot.legacyIssues.length).toBeGreaterThan(0);
      expect(snapshot.sourceConfig.agents?.entries).toBeUndefined();
    });
  });

  it("does not publish partial provenance when a later include fails", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({ agents: { $include: ["./delegating.json", "./missing.json"] } }),
      );
      await fs.writeFile(
        path.join(configDir, "delegating.json"),
        JSON.stringify({ $include: "./entries.json" }),
      );
      await fs.writeFile(
        path.join(configDir, "entries.json"),
        JSON.stringify({ entries: { main: { default: true } } }),
      );
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(snapshot.includeProvenance).toBeUndefined();
    });
  });
});
