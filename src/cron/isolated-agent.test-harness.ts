// Isolated agent test harness builds filesystem and config fixtures for cron agent tests.
import fs from "node:fs/promises";
import path from "node:path";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { AforaConfig } from "../config/types.afora.js";
import { withTempHome as withTempHomeBase } from "../plugin-sdk/test-env.js";
import type { CronJob } from "./types.js";

/** Runs a test callback with an isolated Afora home for cron tests. */
export async function withTempCronHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "afora-cron-" });
}

export async function writeSessionStore(
  home: string,
  session: { lastProvider: string; lastTo: string; lastChannel?: string },
): Promise<string> {
  return writeSessionStoreEntries(home, {
    "agent:main:main": {
      sessionId: "main-session",
      updatedAt: Date.now(),
      ...session,
    },
  });
}

export async function writeSessionStoreEntries(
  home: string,
  entries: Record<string, Record<string, unknown>>,
): Promise<string> {
  const dir = path.join(home, ".afora", "sessions");
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ storePath, sessionKey }, entry as unknown as SessionEntry);
  }
  return storePath;
}

export function makeCfg(
  home: string,
  storePath: string,
  overrides: Partial<AforaConfig> = {},
): AforaConfig {
  const base: AforaConfig = {
    agents: {
      entries: { main: { default: true } },
      defaults: {
        model: "anthropic/claude-opus-4-6",
        workspace: path.join(home, "afora"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  } as AforaConfig;
  return { ...base, ...overrides };
}

export function makeJob(payload: CronJob["payload"]): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "job-1",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    state: {},
  };
}
