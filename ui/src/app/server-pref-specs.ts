import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeSidebarEntries } from "../app-navigation.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import {
  normalizeChatFollowUpModeOverride,
  normalizeChatSendShortcut,
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

export function prefValuesEqual(left: unknown, right: unknown): boolean {
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
export const SYNCED_PREFS = {
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

export type SyncedPrefKey = keyof typeof SYNCED_PREFS;
export type ResettableServerUiPrefKey =
  | "theme"
  | "themeMode"
  | "locale"
  | "chatSendShortcut"
  | "chatFollowUpMode";
export type SyncedPrefValue<K extends SyncedPrefKey> =
  ReturnType<(typeof SYNCED_PREFS)[K]["extract"]> extends (infer T) | undefined ? T : never;
export type ServerUiPrefs = { [K in SyncedPrefKey]?: SyncedPrefValue<K> | null };

export const SYNCED_PREF_KEYS = Object.keys(SYNCED_PREFS) as SyncedPrefKey[];

export function extractServerUiPrefs(configObject: unknown): ServerUiPrefs {
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
export function serverPrefsLocalPatch(
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
