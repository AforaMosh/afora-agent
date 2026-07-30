import type {
  AgentRunResult,
  AgentRunServiceContract,
  AgentRunStart,
} from "./agent-run-service-contract.js";
import type { AgentCommandIngressOpts } from "./command/types.js";
import { createAgentRunDirectAbortError } from "./run-termination.js";

type AgentRunExecutor = (input: AgentCommandIngressOpts) => Promise<AgentRunResult>;

const defaultAgentRunExecutor: AgentRunExecutor = async (input) => {
  const { agentCommandFromIngress } = await import("./agent-command.js");
  return await agentCommandFromIngress(input);
};

export class AgentRunService implements AgentRunServiceContract {
  readonly #activeRuns = new Map<string, AbortController>();
  readonly #execute: AgentRunExecutor;

  constructor(execute: AgentRunExecutor = defaultAgentRunExecutor) {
    this.#execute = execute;
  }

  start(input: AgentRunStart) {
    if (this.#activeRuns.has(input.runId)) {
      throw new Error(`agent run already active: ${input.runId}`);
    }

    const controller = new AbortController();
    const {
      runId,
      sessionKey,
      signal,
      to: _ignoredTo,
      ...opts
    } = input as AgentRunStart & {
      to?: unknown;
    };
    const abortSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

    // Register before invoking the executor so immediate cancellation can
    // always address the run, including executors that fail synchronously.
    this.#activeRuns.set(runId, controller);
    const result = Promise.resolve()
      .then(() =>
        this.#execute({
          ...opts,
          runId,
          sessionKey,
          abortSignal,
        }),
      )
      .finally(() => {
        if (this.#activeRuns.get(runId) === controller) {
          this.#activeRuns.delete(runId);
        }
      });

    return {
      runId,
      result,
      cancel: () => this.#cancel(runId, controller),
    };
  }

  cancel(runId: string): boolean {
    const controller = this.#activeRuns.get(runId);
    return controller ? this.#cancel(runId, controller) : false;
  }

  #cancel(runId: string, controller: AbortController): boolean {
    if (this.#activeRuns.get(runId) !== controller || controller.signal.aborted) {
      return false;
    }
    controller.abort(createAgentRunDirectAbortError());
    return true;
  }
}
