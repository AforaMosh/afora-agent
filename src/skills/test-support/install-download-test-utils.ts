// Install download test utilities provide isolated state and workspace paths.
import {
  createAforaTestState,
  type AforaTestState,
} from "../../test-utils/afora-test-state.js";

/** Creates isolated Afora state for install download tests. */
export async function createInstallDownloadTestState(): Promise<AforaTestState> {
  return await createAforaTestState({
    layout: "state-only",
    prefix: "afora-skills-install-",
  });
}
