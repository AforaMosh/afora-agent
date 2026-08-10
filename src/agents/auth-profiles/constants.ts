/**
 * Shared auth-profile constants.
 * Defines store versions, built-in CLI profile ids, lock budgets, refresh
 * timing, and logging used by auth profile runtime modules.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";

/** Current persisted auth profile store schema version. */
export const AUTH_STORE_VERSION = 1;

/** @deprecated Anthropic provider-owned CLI profile id; do not use from third-party plugins. */
export const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
/** @deprecated OpenAI provider-owned CLI profile id; do not use from third-party plugins. */
export const CODEX_CLI_PROFILE_ID = "openai:codex-cli";
/** Default OpenAI/Codex OAuth profile id used for migrated stores. */
export const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai:default";
/** @deprecated MiniMax provider-owned CLI profile id; do not use from third-party plugins. */
export const MINIMAX_CLI_PROFILE_ID = "minimax-portal:minimax-cli";

// After caller timeout, file-lock liveness retains a non-cooperative owner until
// possible token rotation settles and late success persists.
//
// Retry budget note: keep the MINIMUM cumulative retry window comfortably
// above OAUTH_REFRESH_CALL_TIMEOUT_MS so waiters do not give up while a
// legitimate slow refresh is still within the caller deadline.
/** Cross-agent lock policy for shared OAuth refresh operations. */
export const OAUTH_REFRESH_LOCK_OPTIONS = {
  retries: {
    retries: 20,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 180_000,
} as const;

// Caller deadline for a single OAuth refresh call (plugin hook + HTTP
// token-exchange). Non-cooperative I/O remains owned by the lock until it
// settles so late token rotation persists.
/** Maximum caller wait for one OAuth refresh call inside the refresh lock. */
export const OAUTH_REFRESH_CALL_TIMEOUT_MS = 120_000;

/** Freshness window for syncing external CLI auth into auth profiles. */
export const EXTERNAL_CLI_SYNC_TTL_MS = 15 * 60 * 1000;

/** Auth profile subsystem logger. */
export const log = createSubsystemLogger("agents/auth-profiles");
