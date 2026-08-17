// afora: maps operator-facing AFORA_* env vars onto the upstream OPENCLAW_* names.
// Upstream owns ~1178 OPENCLAW_* vars; renaming them would make every rebase a
// conflict. This aliases instead. An explicitly-set OPENCLAW_* always wins.
const AFORA_PREFIX = "AFORA_";
const UPSTREAM_PREFIX = "OPENCLAW_";

export function applyAforaEnvAliases(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of Object.keys(env)) {
    if (!key.startsWith(AFORA_PREFIX)) {
      continue;
    }
    const value = env[key];
    if (value === undefined) {
      continue;
    }
    const mapped = `${UPSTREAM_PREFIX}${key.slice(AFORA_PREFIX.length)}`;
    if (env[mapped] === undefined) {
      env[mapped] = value;
    }
  }
  return env;
}
