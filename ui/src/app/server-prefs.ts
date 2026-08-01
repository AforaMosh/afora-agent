// Server-side operator display prefs (config ui.prefs) are canonical: agents change them through
// the approval gate and other devices pick them up. The localStorage mirror gives instant boot and
// stays authoritative when this client cannot write config (viewer scope, offline). Pending local
// intent shadows server snapshots until the hash-free LWW ack; failed pushes degrade device-local.
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { normalizeSidebarEntries } from "../app-navigation.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import type { RuntimeConfigCapability } from "../lib/config/index.ts";
import { normalizeGatewayCredentialScope } from "./gateway-scope.ts";
import {
  loadSettings,
  normalizeChatFollowUpModeOverride,
  normalizeChatSendShortcut,
  patchSettings,
  UI_APPEARANCE_DEFAULTS,
  type ChatFollowUpMode,
  type ChatSendShortcut,
  type UiSettings,
} from "./settings.ts";
import type { ThemeMode, ThemeName } from "./theme.ts";
const THEMES: ReadonlySet<ThemeName> = new Set(["claw", "knot", "dash", "custom"]);
const THEME_MODES: ReadonlySet<ThemeMode> = new Set(["light", "dark", "system"]);
type SyncedPrefSpec<T> = {
  extract: (value: unknown) => T | undefined;
  local: (settings: UiSettings) => T | undefined;
  write?: (value: T | undefined) => Partial<UiSettings>;
  canApply?: (value: T, settings: UiSettings) => boolean;
  clearable?: boolean;
  reset?: (settings: UiSettings) => Partial<UiSettings>;
};
const prefSpec = <T>(specification: SyncedPrefSpec<T>) => specification;
function prefValuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}
/**
 * One descriptor per synced pref — the single source of truth for what syncs
 * through config ui.prefs. Each key defines server validation, local normalization,
 * and applicability; `clearable` keys push an explicit JSON null when unset locally
 * so the merge patch removes them server-side.
 */
const SYNCED_PREFS = {
  theme: prefSpec<ThemeName>({
    extract: (value) => (THEMES.has(value as ThemeName) ? (value as ThemeName) : undefined),
    local: (settings) => settings.theme,
    write: (value) => ({ theme: value ?? UI_APPEARANCE_DEFAULTS.theme }),
    clearable: true,
    reset: () => ({ theme: UI_APPEARANCE_DEFAULTS.theme }),
    // A server "custom" theme is only honorable once this browser imported one;
    // the imported palette itself is too large to live in config.
    canApply: (value, settings) => value !== "custom" || Boolean(settings.customTheme),
  }),
  themeMode: prefSpec<ThemeMode>({
    extract: (value) => (THEME_MODES.has(value as ThemeMode) ? (value as ThemeMode) : undefined),
    local: (settings) => settings.themeMode,
    write: (value) => ({ themeMode: value ?? UI_APPEARANCE_DEFAULTS.themeMode }),
    clearable: true,
    reset: () => ({ themeMode: UI_APPEARANCE_DEFAULTS.themeMode }),
  }),
  locale: prefSpec<string>({
    extract: (value) => (typeof value === "string" && isSupportedLocale(value) ? value : undefined),
    local: (settings) => settings.locale,
    write: (value) => ({ locale: value }),
    clearable: true,
    reset: () => ({ locale: undefined }),
  }),
  chatShowThinking: prefSpec<boolean>({
    extract: (value) => (typeof value === "boolean" ? value : undefined),
    local: (settings) => settings.chatShowThinking,
  }),
  chatShowToolCalls: prefSpec<boolean>({
    extract: (value) => (typeof value === "boolean" ? value : undefined),
    local: (settings) => settings.chatShowToolCalls,
  }),
  chatPersistCommentary: prefSpec<boolean>({
    extract: (value) => (typeof value === "boolean" ? value : undefined),
    local: (settings) => settings.chatPersistCommentary !== false,
  }),
  chatSendShortcut: prefSpec<ChatSendShortcut>({
    extract: (value) =>
      value === "enter" || value === "modifier-enter"
        ? normalizeChatSendShortcut(value)
        : undefined,
    local: (settings) => normalizeChatSendShortcut(settings.chatSendShortcut),
    write: (value) => ({ chatSendShortcut: value }),
    clearable: true,
    reset: () => ({ chatSendShortcut: undefined }),
  }),
  chatFollowUpMode: prefSpec<ChatFollowUpMode>({
    extract: (value) => normalizeChatFollowUpModeOverride(value),
    local: (settings) => normalizeChatFollowUpModeOverride(settings.chatFollowUpMode),
    write: (value) => ({ chatFollowUpMode: value }),
    // Unset means "use the server-configured queue mode"; clearing must propagate,
    // so the push serializes an explicit null removal.
    clearable: true,
    reset: () => ({ chatFollowUpMode: undefined }),
  }),
  sidebarEntries: prefSpec<string[]>({
    extract: (value) => normalizeSidebarEntries(value) ?? undefined,
    local: (settings) => settings.sidebarEntries,
  }),
} as const;
type SyncedPrefKey = keyof typeof SYNCED_PREFS;
type ResettableServerUiPrefKey =
  | "theme"
  | "themeMode"
  | "locale"
  | "chatSendShortcut"
  | "chatFollowUpMode";
type SyncedPrefValue<K extends SyncedPrefKey> =
  ReturnType<(typeof SYNCED_PREFS)[K]["extract"]> extends (infer T) | undefined ? T : never;
type ServerUiPrefs = { [K in SyncedPrefKey]?: SyncedPrefValue<K> | null };
type ServerUiPrefsWriter = Pick<RuntimeConfigCapability, "runExternalMutation"> & {
  readonly state: {
    readonly client: GatewayBrowserClient | null;
    readonly connected: boolean;
  };
};
type ServerUiPrefsCommit = {
  needsRefresh: boolean;
  retainedLocal?: boolean;
};
export type ServerUiPrefProvenance = "default" | "pending" | "synced" | "device-local";
export type ServerUiPrefState<T> = {
  overridden: boolean;
  provenance: ServerUiPrefProvenance;
  resetValue: T | undefined;
  value: T | undefined;
};
const SYNCED_PREF_KEYS = Object.keys(SYNCED_PREFS) as SyncedPrefKey[];
function normalizeServerPrefsScope(scope: string): string {
  if (!scope) {
    return "";
  }
  const normalized = normalizeGatewayCredentialScope(scope);
  migrateServerPrefsScope(scope, normalized);
  return normalized;
}
function extractServerUiPrefs(configObject: unknown): ServerUiPrefs {
  const prefs = asRecord(asRecord(asRecord(configObject)?.ui)?.prefs);
  if (!prefs) {
    return {};
  }
  const result: ServerUiPrefs = {};
  for (const key of SYNCED_PREF_KEYS) {
    const value = SYNCED_PREFS[key].extract(prefs[key]);
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

export function resolveServerUiPrefState<K extends SyncedPrefKey>(
  configObject: unknown,
  key: K,
  scope = "",
  settings = loadSettings(),
): ServerUiPrefState<SyncedPrefValue<K>> {
  scope = normalizeServerPrefsScope(scope);
  const specification = SYNCED_PREFS[key];
  const localValue = specification.local(settings) as SyncedPrefValue<K> | undefined;
  const resetPatch = specification.reset?.(settings);
  const productDefault = (
    resetPatch ? specification.local({ ...settings, ...resetPatch }) : undefined
  ) as SyncedPrefValue<K> | undefined;
  const localState = (
    resetValue: SyncedPrefValue<K> | undefined,
  ): ServerUiPrefState<SyncedPrefValue<K>> => {
    const overridden = !prefValuesEqual(localValue, resetValue);
    return {
      overridden,
      provenance: overridden ? "device-local" : "default",
      resetValue,
      value: localValue,
    };
  };
  const shadowPrefs = readPendingPrefsForScope(scope);
  if (shadowPrefs && key in shadowPrefs) {
    const shadowValue = shadowPrefs[key];
    if (shadowValue === null) {
      return { ...localState(productDefault), provenance: "pending" };
    }
    return {
      overridden: true,
      provenance: "pending",
      resetValue: productDefault,
      value: shadowValue as SyncedPrefValue<K>,
    };
  }
  const prefs = asRecord(asRecord(asRecord(configObject)?.ui)?.prefs);
  if (!prefs || !Object.hasOwn(prefs, key)) {
    return localState(productDefault);
  }
  const serverValue = specification.extract(prefs[key]) as SyncedPrefValue<K> | undefined;
  if (serverValue === undefined) {
    return localState(productDefault);
  }
  const canApply =
    !specification.canApply ||
    (specification.canApply as (value: unknown, settings: UiSettings) => boolean)(
      serverValue,
      settings,
    );
  if (!canApply) {
    // The server still owns this authored preference even when this device cannot
    // render it. Preserve that provenance so Restore default removes the override.
    return {
      overridden: true,
      provenance: "synced",
      resetValue: productDefault,
      value: localValue,
    };
  }
  if (prefValuesEqual(localValue, serverValue)) {
    return {
      overridden: true,
      provenance: "synced",
      resetValue: productDefault,
      value: serverValue,
    };
  }
  return localState(serverValue);
}
/** Local-settings patch that would bring the mirror in line with the server. */
function serverPrefsLocalPatch(
  prefs: ServerUiPrefs,
  settings: UiSettings,
): Partial<UiSettings> | null {
  const patch: Partial<UiSettings> = {};
  for (const key of SYNCED_PREF_KEYS) {
    const specification = SYNCED_PREFS[key];
    const serverValue = prefs[key];
    if (serverValue === undefined) {
      continue;
    }
    // Null marks a server-side removal of a clearable key: drop the local override
    // so this device falls back to the server-configured behavior.
    if (serverValue === null) {
      const resetPatch = specification.clearable ? specification.reset?.(settings) : undefined;
      if (resetPatch) {
        for (const [resetKey, resetValue] of Object.entries(resetPatch)) {
          if (
            !prefValuesEqual((settings as unknown as Record<string, unknown>)[resetKey], resetValue)
          ) {
            (patch as Record<string, unknown>)[resetKey] = resetValue;
          }
        }
      }
      continue;
    }
    if (prefValuesEqual(serverValue, specification.local(settings))) {
      continue;
    }
    if (
      specification.canApply &&
      !(specification.canApply as (value: unknown, settings: UiSettings) => boolean)(
        serverValue,
        settings,
      )
    ) {
      continue;
    }
    (patch as Record<string, unknown>)[key] = serverValue;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
/** Synced-key delta between two local settings snapshots, for the push path. */
export function changedServerUiPrefs(previous: UiSettings, next: UiSettings): ServerUiPrefs | null {
  const prefs: ServerUiPrefs = {};
  for (const key of SYNCED_PREF_KEYS) {
    if (requestedDeviceLocalPrefResets.delete(key)) {
      continue;
    }
    if (requestedServerUiPrefResets.delete(key)) {
      (prefs as Record<string, unknown>)[key] = null;
      continue;
    }
    const specification = SYNCED_PREFS[key];
    const previousValue = specification.local(previous);
    const nextValue = specification.local(next);
    if (prefValuesEqual(previousValue, nextValue)) {
      continue;
    }
    if (nextValue === undefined) {
      // JSON merge patch removes keys via explicit null.
      if (specification.clearable) {
        (prefs as Record<string, unknown>)[key] = null;
      }
      continue;
    }
    (prefs as Record<string, unknown>)[key] = nextValue;
  }
  return Object.keys(prefs).length > 0 ? prefs : null;
}
// Last server value this client reconciled against, persisted per gateway scope. Applying only on
// a server delta keeps an unpushable local edit (viewer scope) from being reverted by every later
// snapshot, including the first snapshot after reload or reconnect carrying the same old value.
const LAST_SEEN_KEY = "openclaw.control.serverPrefs.v1";
// Pending keys are local edits not yet acknowledged by the gateway. They shadow reconciliation so
// snapshots cannot revert unacked edits, and persist so offline edits replay after reload/reconnect.
const PENDING_KEY = "openclaw.control.serverPrefs.pending.v1";
const MIGRATED_PENDING_KEY = "openclaw.control.serverPrefs.pending-migrated.v1";
const CONFLICT_REDRAIN_DELAY_MS = 1_000;
const MAX_CONFLICT_REDRAINS = 5;
const MAX_LAST_SEEN_MEMORY_SCOPES = 64;
const requestedServerUiPrefResets = new Set<SyncedPrefKey>();
const requestedDeviceLocalPrefResets = new Set<SyncedPrefKey>();
let applyingServerPrefs = false;
let pendingScope = "";
let pendingPrefs: ServerUiPrefs | null = null;
let pushWriter: ServerUiPrefsWriter | null = null;
let pushScope = "";
let pushAfterCommit: ((commit: ServerUiPrefsCommit) => void) | undefined;
let pushDraining = false;
let drainRequested = false;
let pushEpoch = 0;
let conflictRedrainTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveConflictRedrains = 0;
// A loaded config snapshot object is immutable. Re-evaluating a retained object after lastSeen
// moves would treat stale values as fresh deltas and revert acked edits, including after refresh
// failure. Only new objects are evaluated; the post-ack request-version bump makes them post-commit.
let lastReconciledScope = "";
let lastReconciledConfigObject: unknown = null;
// Storage can be blocked or cleared mid-session. Keep the current process's
// accepted edge so equal snapshot objects do not manufacture theme revisions.
const lastSeenPrefsByScope = new Map<string, string>();
// Unlike lastSeen, pending entries are uncommitted user intent. Never evict
// them merely because durable browser storage is unavailable.
const pendingPrefsByScope = new Map<string, ServerUiPrefs>();
const migratedLegacyPendingScopes = new Set<string>();
const legacyPendingAliasesByScope = new Map<string, Set<string>>();
function rememberScopedValue<T>(map: Map<string, T>, scope: string, value: T | null): void {
  map.delete(scope);
  if (value !== null) {
    map.set(scope, value);
  }
}
function rememberLastSeen(scope: string, value: string): void {
  rememberScopedValue(lastSeenPrefsByScope, scope, value);
  while (lastSeenPrefsByScope.size > MAX_LAST_SEEN_MEMORY_SCOPES) {
    const oldest = lastSeenPrefsByScope.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    lastSeenPrefsByScope.delete(oldest);
  }
}
function clearConflictRedrain(): void {
  if (conflictRedrainTimer !== null) {
    clearTimeout(conflictRedrainTimer);
    conflictRedrainTimer = null;
  }
  consecutiveConflictRedrains = 0;
}
function readStorage(root: string, scope: string): string | null {
  try {
    return globalThis.localStorage?.getItem(`${root}:${scope}`) ?? null;
  } catch {
    return null;
  }
}
function writeStorage(root: string, scope: string, value: string | null): boolean {
  try {
    const key = `${root}:${scope}`;
    if (value === null) {
      globalThis.localStorage?.removeItem(key);
    } else {
      globalThis.localStorage?.setItem(key, value);
    }
    return true;
  } catch {
    // Quota/security failures degrade to in-memory tracking for this session.
    return false;
  }
}
function parseStoredPrefs(raw: string | null): ServerUiPrefs | null {
  try {
    const prefs = asRecord(JSON.parse(raw ?? "null"));
    return prefs && Object.keys(prefs).length ? (prefs as ServerUiPrefs) : null;
  } catch {
    return null;
  }
}
function readPendingPrefsForScope(scope: string): ServerUiPrefs | null {
  const stored = parseStoredPrefs(readStorage(PENDING_KEY, scope));
  const inMemory = pendingPrefsByScope.get(scope);
  const active = scope === pendingScope ? pendingPrefs : null;
  const merged = { ...stored, ...inMemory, ...active };
  return Object.keys(merged).length > 0 ? merged : null;
}
function trailingSlashScopeAlias(scope: string): string {
  try {
    const parsed = new URL(scope);
    if (parsed.pathname !== "/" && !parsed.pathname.endsWith("/")) {
      parsed.pathname += "/";
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return scope.endsWith("/") ? scope : `${scope}/`;
  }
}
function discoverStoredScopeAliases(normalizedScope: string): string[] {
  try {
    const storage = globalThis.localStorage;
    if (!storage) {
      return [];
    }
    const aliases = new Set<string>();
    const prefixes = [`${PENDING_KEY}:`, `${LAST_SEEN_KEY}:`];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      const prefix = prefixes.find((candidate) => key?.startsWith(candidate));
      if (!key || !prefix) {
        continue;
      }
      const scope = key.slice(prefix.length);
      if (scope !== normalizedScope && normalizeGatewayCredentialScope(scope) === normalizedScope) {
        aliases.add(scope);
      }
    }
    return [...aliases];
  } catch {
    return [];
  }
}
function hasPendingMigrationTombstone(scope: string): boolean {
  if (migratedLegacyPendingScopes.has(scope)) {
    return true;
  }
  try {
    return globalThis.sessionStorage?.getItem(`${MIGRATED_PENDING_KEY}:${scope}`) === "1";
  } catch {
    return false;
  }
}
function recordPendingMigrationTombstone(scope: string): void {
  migratedLegacyPendingScopes.add(scope);
  try {
    globalThis.sessionStorage?.setItem(`${MIGRATED_PENDING_KEY}:${scope}`, "1");
  } catch {
    // Process memory still prevents resurrection for this app lifetime.
  }
}
function rememberLegacyPendingAlias(scope: string, legacyScope: string): void {
  const aliases = legacyPendingAliasesByScope.get(scope) ?? new Set<string>();
  aliases.add(legacyScope);
  legacyPendingAliasesByScope.set(scope, aliases);
}
function finalizePendingMigrations(scope: string): void {
  const aliases = legacyPendingAliasesByScope.get(scope);
  if (!aliases) {
    return;
  }
  legacyPendingAliasesByScope.delete(scope);
  for (const legacyScope of aliases) {
    recordPendingMigrationTombstone(legacyScope);
    writeStorage(PENDING_KEY, legacyScope, null);
  }
}
function migrateServerPrefsScope(authoredScope: string, normalizedScope: string): void {
  const aliases = new Set([
    authoredScope,
    trailingSlashScopeAlias(normalizedScope),
    ...discoverStoredScopeAliases(normalizedScope),
  ]);
  for (const legacyScope of aliases) {
    if (legacyScope === normalizedScope) {
      continue;
    }
    const legacyPending = hasPendingMigrationTombstone(legacyScope)
      ? null
      : parseStoredPrefs(readStorage(PENDING_KEY, legacyScope));
    if (legacyPending) {
      const mergedPending = {
        ...legacyPending,
        ...readPendingPrefsForScope(normalizedScope),
      };
      rememberScopedValue(pendingPrefsByScope, normalizedScope, mergedPending);
      rememberLegacyPendingAlias(normalizedScope, legacyScope);
      if (writeStorage(PENDING_KEY, normalizedScope, JSON.stringify(mergedPending))) {
        writeStorage(PENDING_KEY, legacyScope, null);
      }
    }
    const canonicalLastSeen =
      lastSeenPrefsByScope.get(normalizedScope) ?? readStorage(LAST_SEEN_KEY, normalizedScope);
    const legacyLastSeen = readStorage(LAST_SEEN_KEY, legacyScope);
    if (canonicalLastSeen === null && legacyLastSeen !== null) {
      rememberLastSeen(normalizedScope, legacyLastSeen);
      if (writeStorage(LAST_SEEN_KEY, normalizedScope, legacyLastSeen)) {
        writeStorage(LAST_SEEN_KEY, legacyScope, null);
      }
    }
  }
}
function adoptPendingScope(scope: string, force = false): void {
  if (!force && scope === pendingScope) {
    return;
  }
  if (pendingPrefs) {
    rememberScopedValue(pendingPrefsByScope, pendingScope, { ...pendingPrefs });
  }
  pendingScope = scope;
  pendingPrefs = null;
  pendingPrefs = readPendingPrefsForScope(scope);
}
function writePendingStorage(prefs: ServerUiPrefs | null): void {
  rememberScopedValue(pendingPrefsByScope, pendingScope, prefs ? { ...prefs } : null);
  writeStorage(PENDING_KEY, pendingScope, prefs ? JSON.stringify(prefs) : null);
}
// localStorage pending is a cross-tab merged pool per gateway. Per-key read-merge-write prevents
// one tab from clobbering sibling offline intent; its ms-scale race is accepted because storage has
// no CAS and the drain converges through server-side LWW.
function mergePendingIntoStorage(): void {
  const stored = parseStoredPrefs(readStorage(PENDING_KEY, pendingScope)) ?? {};
  const merged = { ...stored, ...pendingPrefs };
  writePendingStorage(Object.keys(merged).length ? merged : null);
}
function settlePendingStorage(ackedBatch: ServerUiPrefs): void {
  const stored = { ...parseStoredPrefs(readStorage(PENDING_KEY, pendingScope)) };
  for (const key of Object.keys(ackedBatch) as SyncedPrefKey[]) {
    if (prefValuesEqual(stored[key], ackedBatch[key])) {
      delete stored[key];
    }
  }
  const merged = { ...stored, ...pendingPrefs };
  writePendingStorage(Object.keys(merged).length ? merged : null);
}
export function resetServerUiPrefsSync(options: { preserveScopedFallback?: boolean } = {}) {
  clearConflictRedrain();
  if (options.preserveScopedFallback && pendingPrefs) {
    rememberScopedValue(pendingPrefsByScope, pendingScope, { ...pendingPrefs });
  }
  applyingServerPrefs = pushDraining = drainRequested = false;
  pendingScope = "";
  pendingPrefs = pushWriter = null;
  pushScope = "";
  lastReconciledScope = "";
  lastReconciledConfigObject = null;
  if (!options.preserveScopedFallback) {
    lastSeenPrefsByScope.clear();
    pendingPrefsByScope.clear();
    for (const scope of migratedLegacyPendingScopes) {
      try {
        globalThis.sessionStorage?.removeItem(`${MIGRATED_PENDING_KEY}:${scope}`);
      } catch {
        // Test/reset cleanup remains best-effort under blocked storage.
      }
    }
    migratedLegacyPendingScopes.clear();
    legacyPendingAliasesByScope.clear();
  }
  requestedServerUiPrefResets.clear();
  requestedDeviceLocalPrefResets.clear();
}

export function resetServerUiPref<K extends ResettableServerUiPrefKey>(
  key: K,
  state?: ServerUiPrefState<SyncedPrefValue<K>>,
): UiSettings {
  const specification = SYNCED_PREFS[key];
  const reset = specification.reset;
  if (!reset) {
    throw new Error(`Server UI preference is not resettable: ${key}`);
  }
  if (state?.provenance === "device-local") {
    const write = specification.write as
      | ((value: SyncedPrefValue<K> | undefined) => Partial<UiSettings>)
      | undefined;
    if (!write) {
      throw new Error(`Server UI preference cannot restore a retained local value: ${key}`);
    }
    requestedDeviceLocalPrefResets.add(key);
    return patchSettings(write(state.resetValue));
  }
  requestedServerUiPrefResets.add(key);
  return patchSettings(reset(loadSettings()));
}
export function applyServerUiPrefs(
  configObject: unknown,
  hooks: {
    scope?: string;
    onApplied: (patch: Partial<UiSettings>) => void;
    onThemeChanged?: (theme: ThemeName | null) => void;
  },
): boolean {
  const scope = normalizeServerPrefsScope(hooks.scope ?? "");
  if (scope === lastReconciledScope && configObject === lastReconciledConfigObject) {
    return false;
  }
  const recordReconciledObject = () => {
    lastReconciledScope = scope;
    lastReconciledConfigObject = configObject;
  };
  const shadowPrefs = readPendingPrefsForScope(scope);
  const prefs = extractServerUiPrefs(configObject);
  const key = JSON.stringify(prefs);
  const lastSeenRaw = lastSeenPrefsByScope.get(scope) ?? readStorage(LAST_SEEN_KEY, scope);
  if (key === lastSeenRaw) {
    rememberLastSeen(scope, key);
    recordReconciledObject();
    return false;
  }
  const lastSeen = parseStoredPrefs(lastSeenRaw) ?? {};
  const changed: ServerUiPrefs = {};
  // Apply per field: only keys whose server value changed since last seen. Reapplying unchanged
  // fields would revert unpushable local edits whenever any other server field moves.
  for (const prefKey of Object.keys(prefs) as Array<keyof ServerUiPrefs>) {
    if (
      !(shadowPrefs && prefKey in shadowPrefs) &&
      (lastSeenRaw === null || !prefValuesEqual(prefs[prefKey], lastSeen[prefKey]))
    ) {
      (changed as Record<string, unknown>)[prefKey] = prefs[prefKey];
    }
  }
  for (const prefKey of Object.keys(lastSeen) as Array<keyof ServerUiPrefs>) {
    if (
      !(prefKey in prefs) &&
      !(shadowPrefs && prefKey in shadowPrefs) &&
      SYNCED_PREFS[prefKey]?.clearable
    ) {
      (changed as Record<string, unknown>)[prefKey] = null;
    }
  }
  writeStorage(LAST_SEEN_KEY, scope, key);
  rememberLastSeen(scope, key);
  recordReconciledObject();
  if (Object.hasOwn(changed, "theme")) {
    hooks.onThemeChanged?.(changed.theme ?? null);
  }
  const patch = serverPrefsLocalPatch(changed, loadSettings());
  if (!patch) {
    return false;
  }
  applyingServerPrefs = true;
  try {
    patchSettings(patch);
  } finally {
    applyingServerPrefs = false;
  }
  hooks.onApplied(patch);
  return true;
}
export function isApplyingServerUiPrefs(): boolean {
  return applyingServerPrefs;
}
function adoptPushWriter(writer: ServerUiPrefsWriter): void {
  const scope = normalizeServerPrefsScope(writer.state.client?.gatewayUrl ?? "");
  if (pushWriter === writer && pushScope === scope) {
    return;
  }
  const unscopedPending = pendingScope === "" ? readPendingPrefsForScope("") : null;
  clearConflictRedrain();
  pushEpoch += 1;
  pushWriter = writer;
  pushScope = scope;
  pushDraining = false;
  adoptPendingScope(scope, true);
  if (scope && unscopedPending && Object.keys(unscopedPending).length) {
    // A preference can be edited before the first gateway client is adopted.
    // Move only that unscoped intent forward; preferences from one real
    // gateway must never bleed into another gateway's scope.
    pendingPrefs = { ...pendingPrefs, ...unscopedPending };
    mergePendingIntoStorage();
    writeStorage(PENDING_KEY, "", null);
    rememberScopedValue(pendingPrefsByScope, "", null);
  }
}
function removeBatch(batch: ServerUiPrefs): void {
  if (!pendingPrefs) {
    return;
  }
  for (const key of Object.keys(batch) as SyncedPrefKey[]) {
    if (prefValuesEqual(pendingPrefs[key], batch[key])) {
      delete pendingPrefs[key];
    }
  }
  if (!Object.keys(pendingPrefs).length) {
    pendingPrefs = null;
  }
}
// Conflicts mean another writer committed, so bounded rescheduling converges under progress.
// The cap prevents an endlessly conflicting server from keeping a timer chain alive.
function scheduleConflictRedrain(writer: ServerUiPrefsWriter, epoch: number): void {
  if (conflictRedrainTimer !== null || consecutiveConflictRedrains >= MAX_CONFLICT_REDRAINS) {
    return;
  }
  consecutiveConflictRedrains += 1;
  conflictRedrainTimer = setTimeout(() => {
    conflictRedrainTimer = null;
    if (pushWriter === writer && pushEpoch === epoch && pendingPrefs) {
      startPendingDrain(writer);
    }
  }, CONFLICT_REDRAIN_DELAY_MS);
}
async function drainPendingPrefs(writer: ServerUiPrefsWriter, epoch: number): Promise<void> {
  while (pendingPrefs) {
    if (pushWriter !== writer || pushEpoch !== epoch) {
      return;
    }
    const batch = { ...pendingPrefs };
    const afterCommit = pushAfterCommit;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (pushWriter !== writer || pushEpoch !== epoch) {
        return;
      }
      const result = await writer.runExternalMutation(
        (client) =>
          // ui.prefs is a deliberately narrow hashless LWW surface enforced by
          // hasHashlessPatchLwwStructure in the gateway. Serialization still
          // matters: a pending whole-config save must commit before this merge.
          client.request("config.patch", {
            raw: JSON.stringify({ ui: { prefs: batch } }),
            ...(batch.sidebarEntries !== undefined
              ? { replacePaths: ["ui.prefs.sidebarEntries"] }
              : {}),
            note: "control-ui prefs sync",
          }),
        { waitForWritesResumed: true },
      );
      if (pushWriter !== writer || pushEpoch !== epoch) {
        return;
      }
      if (result.ok) {
        removeBatch(batch);
        const lastSeen =
          parseStoredPrefs(
            lastSeenPrefsByScope.get(pendingScope) ?? readStorage(LAST_SEEN_KEY, pendingScope),
          ) ?? {};
        const acknowledged = { ...lastSeen };
        for (const key of Object.keys(batch) as SyncedPrefKey[]) {
          if (batch[key] === null) {
            delete acknowledged[key];
          } else {
            (acknowledged as Record<string, unknown>)[key] = batch[key];
          }
        }
        const nextLastSeen = JSON.stringify(acknowledged);
        writeStorage(LAST_SEEN_KEY, pendingScope, nextLastSeen);
        rememberLastSeen(pendingScope, nextLastSeen);
        settlePendingStorage(batch);
        finalizePendingMigrations(pendingScope);
        clearConflictRedrain();
        if (pushWriter !== writer || pushEpoch !== epoch) {
          return;
        }
        if (result.refresh.ok && afterCommit && lastReconciledScope === pendingScope) {
          // The authoritative refresh published while pending intent still
          // shadowed this batch. Re-evaluate that same snapshot after cleanup
          // so a concurrent server value wins without another config.get.
          lastReconciledConfigObject = null;
        }
        afterCommit?.({ needsRefresh: !result.refresh.ok });
        if (pushWriter !== writer || pushEpoch !== epoch) {
          return;
        }
        break;
      }
      if (result.reason === "conflict" && attempt === 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        });
        continue;
      }
      if (result.reason === "conflict") {
        scheduleConflictRedrain(writer, epoch);
        return;
      }
      if (
        result.reason === "error" ||
        result.reason === "unavailable" ||
        result.reason === "suspended"
      ) {
        return;
      }
      // Definitive viewer-scope or validation rejections degrade to device-local state.
      // LAST_SEEN still owns the authoritative server value per key, so identical
      // refreshes and reloads preserve this local edit; only a server delta replaces it.
      removeBatch(batch);
      settlePendingStorage(batch);
      finalizePendingMigrations(pendingScope);
      afterCommit?.({ needsRefresh: false, retainedLocal: true });
      return;
    }
  }
}
function startPendingDrain(writer: ServerUiPrefsWriter): void {
  if (pushDraining) {
    drainRequested = true;
    return;
  }
  if (!pendingPrefs) {
    return;
  }
  pushDraining = true;
  const epoch = pushEpoch;
  void drainPendingPrefs(writer, epoch)
    .catch(() => undefined)
    .finally(() => {
      if (pushWriter === writer && pushEpoch === epoch) {
        pushDraining = false;
        if (drainRequested) {
          drainRequested = false;
          startPendingDrain(writer);
        }
      }
    });
}
export function pushServerUiPrefs(
  writer: ServerUiPrefsWriter,
  prefs: ServerUiPrefs,
  hooks: { afterCommit?: (commit: ServerUiPrefsCommit) => void } = {},
): void {
  adoptPushWriter(writer);
  clearConflictRedrain();
  pendingPrefs = { ...pendingPrefs, ...prefs };
  pushAfterCommit = hooks.afterCommit;
  mergePendingIntoStorage();
  startPendingDrain(writer);
}
export function flushServerUiPrefs(
  writer: ServerUiPrefsWriter,
  hooks: { afterCommit?: (commit: ServerUiPrefsCommit) => void } = {},
): void {
  adoptPushWriter(writer);
  clearConflictRedrain();
  pushEpoch += 1;
  pushDraining = drainRequested = false;
  pushAfterCommit = hooks.afterCommit;
  startPendingDrain(writer);
}
