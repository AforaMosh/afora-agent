// afora-compat: bridges legacy OPENCLAW_* env vars and canonical AFORA_* names.
// Live tenants still export OPENCLAW_* (state dir, profile, config path, gateway
// port, all of it). The codebase reads AFORA_* only. This shim fills each missing
// counterpart in both directions so old environments keep working and child
// processes that still expect the legacy names keep working too.
// Precedence: an explicitly set AFORA_* always wins over its OPENCLAW_* twin.
// This file is allowlisted in docs/afora/REBRAND-ALLOWLIST.txt on purpose.
const CANONICAL_PREFIX = "AFORA_";
const LEGACY_PREFIX = "OPENCLAW_";

let warnedLegacy = false;

export function applyAforaEnvAliases(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (value === undefined) {
      continue;
    }
    if (key.startsWith(LEGACY_PREFIX)) {
      const canonical = `${CANONICAL_PREFIX}${key.slice(LEGACY_PREFIX.length)}`;
      if (env[canonical] === undefined) {
        env[canonical] = value;
        if (!warnedLegacy && env.AFORA_DEBUG_ENV_ALIAS !== "0") {
          warnedLegacy = true;
          if (env.DEBUG || env.AFORA_LOG_LEVEL === "debug" || env.OPENCLAW_LOG_LEVEL === "debug") {
            console.error(
              "afora: legacy OPENCLAW_* environment variables detected; they still work but AFORA_* is canonical.",
            );
          }
        }
      }
    } else if (key.startsWith(CANONICAL_PREFIX)) {
      const legacy = `${LEGACY_PREFIX}${key.slice(CANONICAL_PREFIX.length)}`;
      if (env[legacy] === undefined) {
        env[legacy] = value;
      }
    }
  }
  return env;
}
