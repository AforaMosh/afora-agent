import type { SetupPersistentEffectOptions } from "../channels/plugins/setup-wizard-types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { MemoryImportProviderOutcome } from "../wizard/setup.memory-import.js";
import type { HostedMemoryImportOutcome, HostedSetupCompletion } from "./hosted-setup.runtime.js";

export type BeforeHostedPersistentApply = (
  runtime: RuntimeEnv,
  effect?: SetupPersistentEffectOptions,
) => Promise<void>;

type SetupWizardRunner = (
  prompter: WizardPrompter,
  beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
) => Promise<void | HostedSetupCompletion>;

export type ChatWizardHostDependencies = {
  runChannelSetupWizard?: (
    channel: string,
    prompter: WizardPrompter,
    beforePersistentApply: BeforeHostedPersistentApply,
    abortSignal: AbortSignal,
  ) => Promise<void | HostedSetupCompletion>;
  runSkillsSetupWizard?: SetupWizardRunner;
  runSearchSetupWizard?: SetupWizardRunner;
  runGatewaySetupWizard?: SetupWizardRunner;
  runMemoryImportWizard?: (
    prompter: WizardPrompter,
    beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
    onProviderOutcome: (outcome: MemoryImportProviderOutcome) => void,
  ) => Promise<HostedMemoryImportOutcome>;
  appendAuditEntry?: typeof import("./audit.js").appendSystemAgentAuditEntry;
};
