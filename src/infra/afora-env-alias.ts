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

// afora-compat: the legacy twins this shim wrote ITSELF, per env object, with the value it
// wrote. A twin we mirrored is bookkeeping; an OPENCLAW_* the operator exported is an input.
// Only the record tells them apart, and without it the mirror outlives the canonical value it
// shadows: delete AFORA_X and the next pass fills it straight back in from our own copy. The
// gateway restart path relies on deleting a canonical key to drop a setting between passes
// (pre-bootstrap.ts restoreGatewayEnvChanges), so that resurrection is a live defect, not a
// tidiness one. Keyed on the env object so a caller passing a fresh object gets no history.
const mirroredLegacy = new WeakMap<NodeJS.ProcessEnv, Map<string, string>>();

/** True when `legacy` currently holds the exact value this shim last mirrored into it. */
function isOwnMirror(env: NodeJS.ProcessEnv, legacy: string): boolean {
  const written = mirroredLegacy.get(env)?.get(legacy);
  return written !== undefined && written === env[legacy];
}

function rememberMirror(env: NodeJS.ProcessEnv, legacy: string, value: string): void {
  let written = mirroredLegacy.get(env);
  if (!written) {
    written = new Map();
    mirroredLegacy.set(env, written);
  }
  written.set(legacy, value);
}

export function applyAforaEnvAliases(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (value === undefined) {
      continue;
    }
    if (key.startsWith(LEGACY_PREFIX)) {
      const canonical = `${CANONICAL_PREFIX}${key.slice(LEGACY_PREFIX.length)}`;
      if (env[canonical] === undefined) {
        if (isOwnMirror(env, key)) {
          // The canonical name was deliberately cleared and this twin is only our shadow of
          // it. Drop the shadow rather than reviving a value nothing asked for any more.
          delete env[key];
          mirroredLegacy.get(env)?.delete(key);
          continue;
        }
        env[canonical] = value;
        if (!warnedLegacy && env.AFORA_DEBUG_ENV_ALIAS !== "0") {
          warnedLegacy = true;
          // Read the legacy key directly rather than through its canonical twin: this runs
          // mid-loop, and the alias for AFORA_LOG_LEVEL is only filled once the loop reaches
          // that key, which may be after this one. An operator who set only the legacy spelling
          // would otherwise never see the warning that tells them it is the legacy spelling.
          const legacyDebug = env.OPENCLAW_LOG_LEVEL === "debug"; // afora-compat: OPENCLAW_LOG_LEVEL
          if (env.DEBUG || env.AFORA_LOG_LEVEL === "debug" || legacyDebug) {
            console.error(
              // The prefix is named on purpose. This is the one line that tells an operator
              // which of their variables is the legacy one; a message that withheld the name
              // would be advice nobody can act on, which is the failure D8 records.
              "afora: legacy OPENCLAW_* environment variables detected; they still work but AFORA_* is canonical.", // afora-compat: OPENCLAW_* prefix
            );
          }
        }
      }
    } else if (key.startsWith(CANONICAL_PREFIX)) {
      const legacy = `${LEGACY_PREFIX}${key.slice(CANONICAL_PREFIX.length)}`;
      // A twin we wrote is refreshed when the canonical value moves on, so a child reading the
      // legacy name is never handed a rotated secret's previous value. One the operator set is
      // theirs and is left exactly as it is, which is what lets the canonical win above.
      if (env[legacy] === undefined || (isOwnMirror(env, legacy) && env[legacy] !== value)) {
        env[legacy] = value;
        rememberMirror(env, legacy, value);
      }
    }
  }
  return env;
}
