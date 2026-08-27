/** Process env key that marks child commands as launched by the Afora CLI. */
export const AFORA_CLI_ENV_VAR = "AFORA_CLI";

/** Stable marker value used for Afora-launched subprocess detection. */
const AFORA_CLI_ENV_VALUE = "1";

/** Returns a cloned env object with the Afora CLI marker set. */
export function markAforaExecEnv<T extends Record<string, string | undefined>>(
  /** Source environment to clone before adding the subprocess marker. */
  env: T,
): T {
  return {
    ...env,
    [AFORA_CLI_ENV_VAR]: AFORA_CLI_ENV_VALUE,
  };
}

/** Mutates an existing process env object so current-process children inherit the marker. */
export function ensureAforaExecMarkerOnProcess(
  /** Process env object to mutate; defaults to the current process environment. */
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env[AFORA_CLI_ENV_VAR] = AFORA_CLI_ENV_VALUE;
  return env;
}
