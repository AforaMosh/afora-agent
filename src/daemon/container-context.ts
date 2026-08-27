/** Detects whether a daemon was launched by Afora's container-aware service wrapper. */
import { normalizeOptionalString } from "@afora/normalization-core/string-coerce";

/** Resolves the daemon container hint exposed by managed service environments. */
export function resolveDaemonContainerContext(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return (
    normalizeOptionalString(env.AFORA_CONTAINER_HINT) ||
    normalizeOptionalString(env.AFORA_CONTAINER) ||
    null
  );
}
