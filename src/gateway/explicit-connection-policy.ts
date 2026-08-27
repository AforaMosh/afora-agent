// Explicit connection policy decides when CLI gateway calls can avoid reading
// config because URL and auth were fully supplied by flags.
import type { AforaConfig } from "../config/types.afora.js";
import { trimToUndefined, type ExplicitGatewayAuth } from "./credentials.js";

// Explicit connection policy lets CLI paths skip config IO only when the caller
// provided both a URL and concrete auth. Cron stays a bypass path because it
// owns gateway startup/config loading separately.
function hasExplicitGatewayConnectionAuth(auth?: ExplicitGatewayAuth): boolean {
  return Boolean(trimToUndefined(auth?.token) || trimToUndefined(auth?.password));
}

/** Returns true when url/auth flags are sufficient and loading Afora config is unnecessary. */
export function canSkipGatewayConfigLoad(params: {
  config?: AforaConfig;
  urlOverride?: string;
  explicitAuth?: ExplicitGatewayAuth;
}): boolean {
  return (
    !params.config &&
    Boolean(trimToUndefined(params.urlOverride)) &&
    hasExplicitGatewayConnectionAuth(params.explicitAuth)
  );
}
