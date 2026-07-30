import { expectDefined } from "@openclaw/normalization-core";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listSessionsFromStore } from "./session-utils-list.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

export function describeSessionFromStore(params: {
  canonicalKey: string;
  cfg: OpenClawConfig;
  entry: SessionEntry;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  store: Record<string, SessionEntry>;
  storePath: string;
}): GatewaySessionRow {
  const store =
    params.store[params.canonicalKey] === params.entry
      ? params.store
      : { ...params.store, [params.canonicalKey]: params.entry };
  const listed = listSessionsFromStore({
    cfg: params.cfg,
    storePath: params.storePath,
    store,
    entryFilter: (key) => key === params.canonicalKey,
    includeHidden: true,
    opts: {
      includeDerivedTitles: params.includeDerivedTitles,
      includeLastMessage: params.includeLastMessage,
      limit: 1,
    },
  });
  return expectDefined(listed.sessions[0], "described session");
}
