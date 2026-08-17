import type { SetupAbortablePersistentEffectContext } from "../channels/plugins/setup-wizard-types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardSession } from "../wizard/session.js";

export type BeforeHostedPersistentApply = (runtime: RuntimeEnv) => Promise<void>;

export type RunHostedAbortablePersistentEffect = <T>(
  runtime: RuntimeEnv,
  effect: (context: SetupAbortablePersistentEffectContext) => Promise<T>,
) => Promise<T>;

/** Keep authorization, cancellation, cleanup, and the durable commit transition host-owned. */
export function createChatWizardPersistentEffectBoundary(params: {
  session: WizardSession;
  authorize: (runtime: RuntimeEnv) => Promise<void>;
}): {
  beforePersistentApply: BeforeHostedPersistentApply;
  runAbortablePersistentEffect: RunHostedAbortablePersistentEffect;
} {
  return {
    beforePersistentApply: async (runtime) => {
      params.session.signal.throwIfAborted();
      await params.authorize(runtime);
      params.session.signal.throwIfAborted();
      params.session.lockCancellation();
    },
    runAbortablePersistentEffect: async (runtime, effect) =>
      await params.session.runAbortablePersistentEffect(
        async () => await params.authorize(runtime),
        effect,
      ),
  };
}
