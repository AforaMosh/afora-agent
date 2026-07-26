// Server-side operator display prefs (config ui.prefs) with a browser-local
// mirror. The config value is canonical — agents change it through the
// approval gate and other devices pick it up — while localStorage keeps
// instant boot and stays authoritative when this client cannot write config
// (viewer scope, offline). Sync policy: a server-side *change* wins over the
// local mirror; an unchanged server value never reverts local edits, so a
// failed push degrades to device-local behavior instead of flip-flopping.
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeSidebarEntries } from "../app-navigation.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import { hasCurrentConfigSnapshot, type RuntimeConfigCapability } from "../lib/config/index.ts";
import {
  loadSettings,
  normalizeChatFollowUpModeOverride,
  normalizeChatSendShortcut,
  patchSettings,
  type ChatFollowUpMode,
  type ChatSendShortcut,
  type UiSettings,
} from "./settings.ts";
import type { ThemeMode, ThemeName } from "./theme.ts";

const THEMES: ReadonlySet<ThemeName> = new Set(["claw", "knot", "dash", "custom"]);
const THEME_MODES: ReadonlySet<ThemeMode> = new Set(["light", "dark", "system"]);

/**
 * One descriptor per synced pref — the single source of truth for what syncs
 * through config ui.prefs. Each key defines how to validate the server value,
 * read the normalized local value, and (optionally) whether a server value is
 * applicable on this device. `clearable` keys push an explicit JSON null when
 * unset locally so the merge patch removes them server-side.
 */
type SyncedPrefSpec<T> = {
  extract: (value: unknown) => T | undefined;
  local: (settings: UiSettings) => T | undefined;
  canApply?: (value: T, settings: UiSettings) => boolean;
  clearable?: boolean;
};

const prefSpec = <T>(specification: SyncedPrefSpec<T>) => specification;

function prefValuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

const SYNCED_PREFS = {
  theme: prefSpec<ThemeName>({
    extract: (value) => (THEMES.has(value as ThemeName) ? (value as ThemeName) : undefined),
    local: (settings) => settings.theme,
    // A server "custom" theme is only honorable once this browser imported
    // one; the imported palette itself is too large to live in config.
    canApply: (value, settings) => value !== "custom" || Boolean(settings.customTheme),
  }),
  themeMode: prefSpec<ThemeMode>({
    extract: (value) => (THEME_MODES.has(value as ThemeMode) ? (value as ThemeMode) : undefined),
    local: (settings) => settings.themeMode,
  }),
  locale: prefSpec<string>({
    extract: (value) => (typeof value === "string" && isSupportedLocale(value) ? value : undefined),
    local: (settings) => settings.locale,
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
  }),
  chatFollowUpMode: prefSpec<ChatFollowUpMode>({
    extract: (value) => normalizeChatFollowUpModeOverride(value),
    local: (settings) => normalizeChatFollowUpModeOverride(settings.chatFollowUpMode),
    // Unset means "use the server-configured queue mode"; clearing must
    // propagate, so the push serializes an explicit null removal.
    clearable: true,
  }),
  sidebarEntries: prefSpec<string[]>({
    extract: (value) => normalizeSidebarEntries(value) ?? undefined,
    local: (settings) => settings.sidebarEntries,
  }),
  showAdvancedSettings: prefSpec<boolean>({
    extract: (value) => (typeof value === "boolean" ? value : undefined),
    local: (settings) => settings.showAdvancedSettings === true,
  }),
} as const;

type SyncedPrefKey = keyof typeof SYNCED_PREFS;
type SyncedPrefValue<K extends SyncedPrefKey> =
  ReturnType<(typeof SYNCED_PREFS)[K]["extract"]> extends (infer T) | undefined ? T : never;

type ServerUiPrefs = { [K in SyncedPrefKey]?: SyncedPrefValue<K> | null };

const SYNCED_PREF_KEYS = Object.keys(SYNCED_PREFS) as SyncedPrefKey[];

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
    // Null marks a server-side removal of a clearable key: drop the local
    // override so this device falls back to the server-configured behavior.
    if (serverValue === null) {
      if (specification.clearable && specification.local(settings) !== undefined) {
        (patch as Record<string, unknown>)[key] = undefined;
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

// Last server value this client reconciled against, persisted per gateway
// scope. Applying only on a server *delta* keeps an unpushable local edit
// (viewer scope) from being reverted by every later snapshot — including the
// first snapshot after a reload or reconnect — carrying the same old value.
const LAST_SEEN_STORAGE_KEY = "openclaw.control.serverPrefs.v1";

let lastSeenScope = "";
let lastSeenServerPrefsKey: string | null = null;
// Only revisions proven to be either the exact replaced CAS base or the
// gateway-acknowledged, superseded local commit may be suppressed. External
// snapshots must continue to reconcile normally.
const staleConfigHashes = new Map<string, "replaced" | "committed">();
const STALE_CONFIG_HASH_LIMIT = 8;
let applyingServerPrefs = false;

function loadLastSeenKey(scope: string): string | null {
  if (scope !== lastSeenScope) {
    lastSeenScope = scope;
    try {
      lastSeenServerPrefsKey = globalThis.localStorage?.getItem(
        `${LAST_SEEN_STORAGE_KEY}:${scope}`,
      );
    } catch {
      lastSeenServerPrefsKey = null;
    }
  }
  return lastSeenServerPrefsKey;
}

function storeLastSeenKey(scope: string, key: string) {
  lastSeenScope = scope;
  lastSeenServerPrefsKey = key;
  try {
    globalThis.localStorage?.setItem(`${LAST_SEEN_STORAGE_KEY}:${scope}`, key);
  } catch {
    // Quota/security failures degrade to in-memory tracking for this session.
  }
}

export function resetServerUiPrefsSync() {
  lastSeenScope = "";
  lastSeenServerPrefsKey = null;
  staleConfigHashes.clear();
  applyingServerPrefs = false;
  queuedRuntimeConfig = null;
  queuedConnectionEpoch = null;
  queuedPrefs = null;
  queuedPrefsRequireCurrentSnapshot = false;
  activePrefsCommit = null;
  pushDraining = false;
  prefsSyncGeneration += 1;
}

export function applyServerUiPrefs(
  configObject: unknown,
  hooks: {
    scope?: string;
    snapshotHash?: string;
    runtimeConfig?: RuntimeConfigCapability;
    onApplied: (patch: Partial<UiSettings>) => void;
  },
): boolean {
  if (hooks.runtimeConfig) {
    const runtimeConfig = hooks.runtimeConfig;
    adoptPrefsOwner(runtimeConfig);
    const runtimeSnapshot = runtimeConfig.state.configSnapshot;
    if (
      queuedPrefsRequireCurrentSnapshot &&
      runtimeSnapshot?.hash &&
      hooks.snapshotHash === runtimeSnapshot.hash &&
      hasCurrentConfigSnapshot(runtimeConfig) &&
      isCurrentPrefsOwner(runtimeConfig, prefsSyncGeneration, runtimeConfig.connectionEpoch) &&
      (configObject === runtimeSnapshot.config || configObject === runtimeSnapshot.sourceConfig)
    ) {
      queuedPrefsRequireCurrentSnapshot = false;
    }
  }
  const scope = hooks.scope ?? "";
  const prefs = extractServerUiPrefs(configObject);
  if (hooks.snapshotHash) {
    const runtimeConfig = hooks.runtimeConfig;
    const runtimeSnapshot = runtimeConfig?.state.configSnapshot;
    const pendingCommit = activePrefsCommit;
    const isAuthoritativeCommitSnapshot = Boolean(
      pendingCommit &&
      runtimeConfig &&
      runtimeSnapshot &&
      runtimeConfig === pendingCommit.runtimeConfig &&
      isCurrentPrefsOwner(runtimeConfig, pendingCommit.generation, pendingCommit.connectionEpoch) &&
      runtimeSnapshot !== pendingCommit.snapshot &&
      !runtimeConfig.state.configLoading &&
      hooks.snapshotHash === runtimeSnapshot.hash &&
      (configObject === runtimeSnapshot.config || configObject === runtimeSnapshot.sourceConfig),
    );
    const staleKind = staleConfigHashes.get(hooks.snapshotHash);
    if (staleKind === "replaced" && !isAuthoritativeCommitSnapshot) {
      return false;
    }
    if (staleKind === "committed") {
      const commit = activePrefsCommit;
      if (
        !commit ||
        (isCurrentPrefsOwner(commit.runtimeConfig, commit.generation, commit.connectionEpoch) &&
          commit.hash === hooks.snapshotHash &&
          Object.keys(commit.prefs).every((key) => {
            const prefKey = key as SyncedPrefKey;
            const committedValue = commit.prefs[prefKey];
            return committedValue === null
              ? !(prefKey in prefs)
              : prefValuesEqual(prefs[prefKey], committedValue);
          }))
      ) {
        // Observe our real committed server values without applying them over
        // newer device-local intent. Later foreign revisions must delta from
        // this acknowledged snapshot, not replay its superseded preferences.
        storeLastSeenKey(scope, JSON.stringify(prefs));
        if (commit?.hash === hooks.snapshotHash) {
          activePrefsCommit = null;
          // Content hashes can recur when another writer restores the old
          // bytes. The observed commit is the only safe point to retire its
          // replaced predecessor before that genuine restoration arrives.
          staleConfigHashes.clear();
        } else {
          staleConfigHashes.delete(hooks.snapshotHash);
        }
        return false;
      }
    }
    const commit = activePrefsCommit;
    if (
      commit &&
      isCurrentPrefsOwner(commit.runtimeConfig, commit.generation, commit.connectionEpoch) &&
      (hooks.snapshotHash !== commit.baseHash || isAuthoritativeCommitSnapshot)
    ) {
      // A newer snapshot can arrive before the physically acknowledged
      // commit. Seed every owned field from that real commit first so a
      // foreign restoration or removal remains a genuine server delta.
      const baseline = parseLastSeenPrefs(loadLastSeenKey(scope));
      for (const prefKey of Object.keys(commit.prefs) as SyncedPrefKey[]) {
        const committedValue = commit.prefs[prefKey];
        if (committedValue === null) {
          delete baseline[prefKey];
        } else {
          (baseline as Record<string, unknown>)[prefKey] = committedValue;
        }
      }
      storeLastSeenKey(scope, JSON.stringify(baseline));
      activePrefsCommit = null;
    }
    // Post-patch state observed: retire the stale marks. Hashes identify
    // content, not age — if the pre-patch hash reappears later, another
    // writer genuinely restored that config and it is authoritative again.
    staleConfigHashes.clear();
  }
  const key = JSON.stringify(prefs);
  const lastSeenRaw = loadLastSeenKey(scope);
  if (key === lastSeenRaw) {
    return false;
  }
  // Apply per field: only keys whose *server* value changed since last seen.
  // Reapplying unchanged fields would revert unpushable local edits on other
  // keys whenever any one server field moves.
  const lastSeen = parseLastSeenPrefs(lastSeenRaw);
  const changed: ServerUiPrefs = {};
  for (const prefKey of Object.keys(prefs) as Array<keyof ServerUiPrefs>) {
    if (lastSeenRaw === null || !prefValuesEqual(prefs[prefKey], lastSeen[prefKey])) {
      (changed as Record<string, unknown>)[prefKey] = prefs[prefKey];
    }
  }
  // A clearable key that disappeared from the server was removed by another
  // writer; surface the removal as an explicit null so the local override
  // clears too (non-clearable keys keep their device-local value).
  for (const prefKey of Object.keys(lastSeen) as Array<keyof ServerUiPrefs>) {
    if (!(prefKey in prefs) && SYNCED_PREFS[prefKey]?.clearable) {
      (changed as Record<string, unknown>)[prefKey] = null;
    }
  }
  storeLastSeenKey(scope, key);
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

function parseLastSeenPrefs(value: string | null): ServerUiPrefs {
  try {
    return value ? (JSON.parse(value) as ServerUiPrefs) : {};
  } catch {
    return {};
  }
}

// Coalesce UI intent only; the runtime capability exclusively owns physical
// writes, CAS refresh, updater suspension, and connection-epoch fencing.
let queuedRuntimeConfig: RuntimeConfigCapability | null = null;
let queuedConnectionEpoch: number | null = null;
let queuedPrefs: ServerUiPrefs | null = null;
let queuedPrefsRequireCurrentSnapshot = false;
let activePrefsCommit: {
  runtimeConfig: RuntimeConfigCapability;
  generation: number;
  connectionEpoch: number;
  snapshot: RuntimeConfigCapability["state"]["configSnapshot"];
  baseHash: string;
  hash: string | null;
  prefs: ServerUiPrefs;
} | null = null;
let pushDraining = false;
let prefsSyncGeneration = 0;

function rememberStaleConfigHash(hash: string, kind: "replaced" | "committed") {
  if (kind === "committed" || !staleConfigHashes.has(hash)) {
    staleConfigHashes.set(hash, kind);
  }
  if (staleConfigHashes.size > STALE_CONFIG_HASH_LIMIT) {
    const oldest = staleConfigHashes.keys().next().value;
    if (oldest !== undefined) {
      staleConfigHashes.delete(oldest);
    }
  }
}

function adoptPrefsOwner(runtimeConfig: RuntimeConfigCapability) {
  const connectionEpoch = runtimeConfig.connectionEpoch;
  if (queuedRuntimeConfig === runtimeConfig && queuedConnectionEpoch === connectionEpoch) {
    return;
  }
  const previousConnectionSnapshot = queuedRuntimeConfig === runtimeConfig;
  // Snapshot hashes identify bytes, not a gateway or physical connection.
  // Retire the old owner's marks before the first new snapshot can collide.
  staleConfigHashes.clear();
  queuedRuntimeConfig = runtimeConfig;
  queuedConnectionEpoch = connectionEpoch;
  queuedPrefs = null;
  queuedPrefsRequireCurrentSnapshot = previousConnectionSnapshot;
  activePrefsCommit = null;
  pushDraining = false;
  prefsSyncGeneration += 1;
}

function isCurrentPrefsOwner(
  runtimeConfig: RuntimeConfigCapability,
  generation: number,
  connectionEpoch: number,
): boolean {
  return (
    queuedRuntimeConfig === runtimeConfig &&
    queuedConnectionEpoch === connectionEpoch &&
    prefsSyncGeneration === generation &&
    runtimeConfig.connectionEpoch === connectionEpoch
  );
}

async function drainPrefsQueue(
  runtimeConfig: RuntimeConfigCapability,
  generation: number,
  connectionEpoch: number,
): Promise<void> {
  while (queuedPrefs) {
    if (!isCurrentPrefsOwner(runtimeConfig, generation, connectionEpoch)) {
      return;
    }
    if (queuedPrefsRequireCurrentSnapshot || !runtimeConfig.state.configSnapshot?.hash) {
      const previousSnapshot = runtimeConfig.state.configSnapshot;
      const requireCurrentSnapshot = queuedPrefsRequireCurrentSnapshot;
      // Reconnects retain their old snapshot. The config owner must first
      // publish a snapshot from this physical epoch before it supplies a CAS base.
      await runtimeConfig.ensureLoaded();
      if (
        !isCurrentPrefsOwner(runtimeConfig, generation, connectionEpoch) ||
        !runtimeConfig.state.configSnapshot?.hash ||
        (requireCurrentSnapshot && runtimeConfig.state.configSnapshot === previousSnapshot)
      ) {
        return;
      }
      queuedPrefsRequireCurrentSnapshot = false;
    }
    const prefs = queuedPrefs;
    queuedPrefs = null;
    let physicallyCommitted = false;
    const didCommit = await runtimeConfig.patch({
      raw: { ui: { prefs } },
      ...(prefs.sidebarEntries !== undefined ? { replacePaths: ["ui.prefs.sidebarEntries"] } : {}),
      note: "control-ui prefs sync",
      onCommitted: ({ hash, baseHash }) => {
        if (!isCurrentPrefsOwner(runtimeConfig, generation, connectionEpoch)) {
          return;
        }
        physicallyCommitted = true;
        rememberStaleConfigHash(baseHash, "replaced");
        // The ack precedes authoritative config.get publication. Keep its
        // physical hash and preference baseline until an owned snapshot is
        // observed, even when the first authoritative reload fails.
        activePrefsCommit = {
          runtimeConfig,
          generation,
          connectionEpoch,
          snapshot: runtimeConfig.state.configSnapshot,
          baseHash,
          hash,
          prefs,
        };
        if (hash) {
          rememberStaleConfigHash(hash, "committed");
        }
      },
    });
    if (!isCurrentPrefsOwner(runtimeConfig, generation, connectionEpoch)) {
      return;
    }
    if (!didCommit && !physicallyCommitted) {
      return;
    }
  }
}

/**
 * Best-effort write-through of a local pref change to config ui.prefs.
 * Silent on failure by design: clients without operator.admin (or offline)
 * keep the change device-local.
 */
export function pushServerUiPrefs(
  runtimeConfig: RuntimeConfigCapability,
  prefs: ServerUiPrefs,
): void {
  adoptPrefsOwner(runtimeConfig);
  const connectionEpoch = runtimeConfig.connectionEpoch;
  if (
    activePrefsCommit?.runtimeConfig === runtimeConfig &&
    activePrefsCommit.generation === prefsSyncGeneration &&
    activePrefsCommit.connectionEpoch === connectionEpoch &&
    activePrefsCommit.hash
  ) {
    rememberStaleConfigHash(activePrefsCommit.hash, "committed");
  }
  queuedPrefs = { ...queuedPrefs, ...prefs };
  if (pushDraining) {
    return;
  }
  pushDraining = true;
  const generation = prefsSyncGeneration;
  void drainPrefsQueue(runtimeConfig, generation, connectionEpoch)
    .catch(() => undefined)
    .finally(() => {
      if (isCurrentPrefsOwner(runtimeConfig, generation, connectionEpoch)) {
        pushDraining = false;
      }
    });
}
