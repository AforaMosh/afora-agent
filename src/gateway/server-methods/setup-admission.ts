import { resolveStateDir } from "../../config/paths.js";
import { FILE_LOCK_TIMEOUT_ERROR_CODE } from "../../infra/file-lock.js";
import { createDeferred } from "../../shared/deferred.js";
import { WizardSession } from "../../wizard/session.js";
import { withSetupMigrationTargetLock } from "../../wizard/setup.migration-snapshot.js";

export const SETUP_ADMISSION_BUSY_MESSAGE =
  "OpenClaw setup is already in progress; try again when it finishes.";

let wizardSessionInProgress = false;

export class SetupAdmissionBusyError extends Error {}

type WizardSessionRunner = ConstructorParameters<typeof WizardSession>[0];

class AdmittedWizardSession extends WizardSession {
  private readonly admittedSettlement: Promise<void>;
  private lifecycleSettled = false;
  private ownerReleaseError: string | undefined;

  constructor(
    runner: WizardSessionRunner,
    options: { ownerRelease: () => Promise<void>; timeoutMs?: number },
  ) {
    super(
      async (...args) => {
        // The base constructor starts its runner immediately. Yield until this
        // subtype's settlement overrides are initialized before exposing it.
        await Promise.resolve();
        await runner(...args);
      },
      options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs },
    );
    // Base settlement is raw runner completion. Only this Gateway-owned subtype
    // extends it through release of the process reservation and target lock.
    this.admittedSettlement = super
      .whenSettled()
      .then(() => options.ownerRelease())
      .catch((error: unknown) => {
        this.ownerReleaseError = String(error);
        throw error;
      })
      .finally(() => {
        this.lifecycleSettled = true;
      });
    // Release can fail before a detached Gateway caller observes settlement.
    void this.admittedSettlement.catch(() => undefined);
  }

  override getStatus() {
    return this.ownerReleaseError === undefined ? super.getStatus() : "error";
  }

  override isSettled(): boolean {
    return this.lifecycleSettled;
  }

  override whenSettled(): Promise<void> {
    return this.admittedSettlement;
  }

  override getError(): string | undefined {
    return this.ownerReleaseError ?? super.getError();
  }
}

export async function runExclusiveSystemAgentSetupActivation<T>(
  task: () => Promise<T>,
): Promise<T> {
  let admitted = false;
  const admittedTask = async () => {
    admitted = true;
    return await task();
  };
  try {
    return await withSetupMigrationTargetLock(resolveStateDir(), admittedTask, { wait: false });
  } catch (error) {
    if (!admitted && (error as { code?: unknown }).code === FILE_LOCK_TIMEOUT_ERROR_CODE) {
      throw new SetupAdmissionBusyError(SETUP_ADMISSION_BUSY_MESSAGE);
    }
    throw error;
  }
}

export async function createAdmittedWizardSession(
  runner: WizardSessionRunner,
  options?: { lockSetupTarget?: boolean; timeoutMs?: number },
): Promise<WizardSession | undefined> {
  if (wizardSessionInProgress) {
    return undefined;
  }
  wizardSessionInProgress = true;
  const runnerSettled = createDeferred();
  let ownerRelease: Promise<void>;
  const releaseProcessAdmission = () => {
    wizardSessionInProgress = false;
  };
  const createSession = () =>
    new AdmittedWizardSession(runner, {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ownerRelease: async () => {
        runnerSettled.resolve(undefined);
        await ownerRelease;
      },
    });
  if (options?.lockSetupTarget !== false) {
    const sessionStarted = createDeferred<WizardSession>();
    let sessionCreated = false;
    const admission = runExclusiveSystemAgentSetupActivation(async () => {
      const session = createSession();
      sessionCreated = true;
      sessionStarted.resolve(session);
      await runnerSettled.promise;
    });
    ownerRelease = admission.finally(releaseProcessAdmission);
    void ownerRelease.catch((error: unknown) => {
      if (!sessionCreated) {
        sessionStarted.reject(error);
      }
    });
    try {
      return await sessionStarted.promise;
    } catch (error) {
      if (error instanceof SetupAdmissionBusyError) {
        return undefined;
      }
      throw error;
    }
  }
  ownerRelease = runnerSettled.promise.finally(releaseProcessAdmission);
  try {
    return createSession();
  } catch (error) {
    releaseProcessAdmission();
    throw error;
  }
}
