import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredAforaTmpDir } from "../../infra/tmp-afora-dir.js";
import { closeAforaStateDatabaseForTest } from "../../state/afora-state-db.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

export type IngressDrainTestPayload = { text: string };

export function createTestIngressQueue(
  stateDir: string,
  options: Omit<
    Parameters<typeof createChannelIngressQueue>[0],
    "channelId" | "accountId" | "stateDir"
  > = {},
) {
  return createChannelIngressQueue<IngressDrainTestPayload>({
    channelId: "test",
    accountId: "a",
    stateDir,
    ...options,
  });
}

export async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(
    path.join(resolvePreferredAforaTmpDir(), "afora-ingress-drain-"),
  );
  try {
    return await fn(stateDir);
  } finally {
    closeAforaStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}
