// Home environment test support isolates HOME-style paths for skill tests.
import os from "node:os";
import { vi } from "vitest";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";

/** Process home env snapshot used by skill loader tests. */
export type SkillsHomeEnvSnapshot = {
  previousHome: string | undefined;
  previousAforaHome: string | undefined;
  previousAforaStateDir: string | undefined;
  previousUserProfile: string | undefined;
};

export function setMockSkillsHomeEnv(fakeHome: string): SkillsHomeEnvSnapshot {
  const snapshot: SkillsHomeEnvSnapshot = {
    previousHome: process.env.HOME,
    previousAforaHome: process.env.AFORA_HOME,
    previousAforaStateDir: process.env.AFORA_STATE_DIR,
    previousUserProfile: process.env.USERPROFILE,
  };
  setTestEnvValue("HOME", fakeHome);
  deleteTestEnvValue("AFORA_HOME");
  deleteTestEnvValue("AFORA_STATE_DIR");
  deleteTestEnvValue("USERPROFILE");
  vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  return snapshot;
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    deleteTestEnvValue(key);
  } else {
    setTestEnvValue(key, value);
  }
}

export async function restoreMockSkillsHomeEnv(
  snapshot: SkillsHomeEnvSnapshot,
  cleanup?: () => Promise<void> | void,
) {
  vi.restoreAllMocks();
  restoreEnvValue("HOME", snapshot.previousHome);
  restoreEnvValue("AFORA_HOME", snapshot.previousAforaHome);
  restoreEnvValue("AFORA_STATE_DIR", snapshot.previousAforaStateDir);
  restoreEnvValue("USERPROFILE", snapshot.previousUserProfile);
  await cleanup?.();
}
