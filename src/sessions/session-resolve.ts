// Canonical session selector resolution.
// Resolves key/sessionId/label selectors into one canonical session key.
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { canonicalizeSessionEntryAliases, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadCombinedSessionStore } from "./session-combined-store.js";
import { sortAndLimitSessionEntries } from "./session-entry-order.js";
import { isSessionEntryVisible } from "./session-entry-visibility.js";
import { resolveSessionIdMatchSelection } from "./session-id-resolution.js";
import { parseSessionLabel } from "./session-label.js";
import { resolveDeletedAgentIdFromSessionKey } from "./session-owner-validation.js";
import type {
  SessionResolveError,
  SessionResolveInput,
  SessionResolveResult,
  SessionSelector,
} from "./session-service-contract.js";
import { resolveSessionStoreTargetWithStore } from "./session-store-target.js";

function resolveSessionVisibilityFilterOptions(p: SessionSelector) {
  return {
    includeGlobal: p.includeGlobal === true,
    includeUnknown: p.includeUnknown === true,
    spawnedBy: p.spawnedBy,
    agentId: p.agentId,
  };
}

function resolveError(kind: SessionResolveError["kind"], message: string): SessionResolveResult {
  return { ok: false, error: { kind, message } };
}

function resolveSuccess(key: string): SessionResolveResult {
  return { ok: true, value: { key } };
}

function noSessionFoundResult(params: {
  p: SessionSelector;
  message: string;
}): SessionResolveResult {
  if (params.p.allowMissing) {
    return { ok: true, value: null };
  }
  return resolveError("not-found", params.message);
}

/** Rejects sessions whose owning agent no longer exists in config (#65524). */
function validateSessionAgentExists(
  cfg: OpenClawConfig,
  key: string,
  entry?: SessionEntry | null,
  options?: { acpMetadataSessionKey?: string | null },
): SessionResolveResult | null {
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, key, entry, options);
  if (deletedAgentId === null) {
    return null;
  }
  return resolveError(
    "agent-not-found",
    `Agent "${deletedAgentId}" no longer exists in configuration`,
  );
}

function isResolvedSessionKeyVisible(params: {
  p: SessionSelector;
  store: Record<string, SessionEntry>;
  key: string;
}) {
  if (typeof params.p.spawnedBy !== "string" || params.p.spawnedBy.trim().length === 0) {
    return true;
  }
  const entry = params.store[params.key];
  return entry
    ? isSessionEntryVisible({
        key: params.key,
        entry,
        now: Date.now(),
        options: resolveSessionVisibilityFilterOptions(params.p),
      })
    : false;
}

function findVisibleSessionMatches(params: {
  store: Record<string, SessionEntry>;
  p: SessionSelector;
  limit?: number;
  matches: (key: string, entry: SessionEntry) => boolean;
}): Array<[string, SessionEntry]> {
  const now = Date.now();
  const entries = Object.entries(params.store).filter(
    ([key, entry]) =>
      isSessionEntryVisible({
        key,
        entry,
        now,
        options: resolveSessionVisibilityFilterOptions(params.p),
      }) && params.matches(key, entry),
  );
  return sortAndLimitSessionEntries(entries, params.limit);
}

export async function resolveSessionSelector(
  input: SessionResolveInput,
): Promise<SessionResolveResult> {
  const { config: cfg, selector: p } = input;

  const key = normalizeOptionalString(p.key) ?? "";
  const hasKey = key.length > 0;
  const sessionId = normalizeOptionalString(p.sessionId) ?? "";
  const hasSessionId = sessionId.length > 0;
  const hasLabel = (normalizeOptionalString(p.label) ?? "").length > 0;
  const selectionCount = [hasKey, hasSessionId, hasLabel].filter(Boolean).length;
  if (selectionCount > 1) {
    return resolveError(
      "invalid-selector",
      "Provide either key, sessionId, or label (not multiple)",
    );
  }
  if (selectionCount === 0) {
    return resolveError("invalid-selector", "Either key, sessionId, or label is required");
  }

  if (hasKey) {
    // Key lookups may hit legacy store aliases. Migrate/prune before returning
    // the canonical key so later calls operate on one store identity.
    const target = resolveSessionStoreTargetWithStore({ cfg, key, clone: false });
    const store = target.store;
    if (store[target.canonicalKey]) {
      if (
        !isResolvedSessionKeyVisible({
          p,
          store,
          key: target.canonicalKey,
        })
      ) {
        return noSessionFoundResult({ p, message: `No session found: ${key}` });
      }
      const agentCheck = validateSessionAgentExists(
        cfg,
        target.canonicalKey,
        store[target.canonicalKey],
        { acpMetadataSessionKey: target.canonicalKey },
      );
      if (agentCheck) {
        return agentCheck;
      }
      return resolveSuccess(target.canonicalKey);
    }
    const legacyKey = target.storeKeys.find((candidate) => store[candidate]);
    if (!legacyKey) {
      return noSessionFoundResult({ p, message: `No session found: ${key}` });
    }
    await canonicalizeSessionEntryAliases({
      storePath: target.storePath,
      target: {
        canonicalKey: target.canonicalKey,
        storeKeys: target.storeKeys,
      },
    });
    const refreshedTarget = resolveSessionStoreTargetWithStore({
      cfg,
      key: target.canonicalKey,
      clone: false,
    });
    if (
      !isResolvedSessionKeyVisible({
        p,
        store: refreshedTarget.store,
        key: refreshedTarget.canonicalKey,
      })
    ) {
      return noSessionFoundResult({ p, message: `No session found: ${key}` });
    }
    const agentCheckLegacy = validateSessionAgentExists(
      cfg,
      refreshedTarget.canonicalKey,
      refreshedTarget.store[refreshedTarget.canonicalKey],
      { acpMetadataSessionKey: refreshedTarget.canonicalKey },
    );
    if (agentCheckLegacy) {
      return agentCheckLegacy;
    }
    return resolveSuccess(refreshedTarget.canonicalKey);
  }

  if (hasSessionId) {
    // sessionId can collide across stores; delegate selection so exact key
    // matches and ambiguity rules stay shared with other session-id callers.
    const { store } = loadCombinedSessionStore(cfg, { agentId: p.agentId });
    const matches = findVisibleSessionMatches({
      store,
      p,
      matches: (key, entry) => entry.sessionId === sessionId || key === sessionId,
    });
    const selection = resolveSessionIdMatchSelection(matches, sessionId);
    if (selection.kind === "none") {
      return noSessionFoundResult({ p, message: `No session found: ${sessionId}` });
    }
    if (selection.kind === "ambiguous") {
      const keys = selection.sessionKeys.join(", ");
      return resolveError(
        "ambiguous",
        `Multiple sessions found for sessionId: ${sessionId} (${keys})`,
      );
    }
    const selectedEntry = matches.find(([matchKey]) => matchKey === selection.sessionKey)?.[1];
    const agentCheckSessionId = validateSessionAgentExists(
      cfg,
      selection.sessionKey,
      selectedEntry,
    );
    if (agentCheckSessionId) {
      return agentCheckSessionId;
    }
    return resolveSuccess(selection.sessionKey);
  }

  const parsedLabel = parseSessionLabel(p.label);
  if (!parsedLabel.ok) {
    return resolveError("invalid-label", parsedLabel.error);
  }

  const { store } = loadCombinedSessionStore(cfg, { agentId: p.agentId });
  const matches = findVisibleSessionMatches({
    store,
    p,
    limit: 2,
    matches: (_key, entry) => entry.label === parsedLabel.label,
  });
  if (matches.length === 0) {
    return noSessionFoundResult({
      p,
      message: `No session found with label: ${parsedLabel.label}`,
    });
  }
  if (matches.length > 1) {
    const keys = matches.map(([key]) => key).join(", ");
    return resolveError(
      "ambiguous",
      `Multiple sessions found with label: ${parsedLabel.label} (${keys})`,
    );
  }

  const [labelKey, labelEntry] = expectDefined(matches[0], "label match");
  const agentCheckLabel = validateSessionAgentExists(cfg, labelKey, labelEntry);
  if (agentCheckLabel) {
    return agentCheckLabel;
  }
  return resolveSuccess(labelKey);
}
