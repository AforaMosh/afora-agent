import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import type { ConfigUiHint } from "../../api/types.ts";
import type { JsonSchema } from "../../components/config-form.shared.ts";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { setPathValue } from "../../lib/config-form-utils.ts";

export type FocusedSettingReloadKind = "restart" | "hot" | "none";

export type FocusedSettingLookup = {
  path: string;
  schema: JsonSchema;
  reloadKind?: FocusedSettingReloadKind;
  hint?: ConfigUiHint;
};

export type FocusedSettingLookupState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; lookup: FocusedSettingLookup };

const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export function focusedSettingPathSegments(path: string): string[] | null {
  const segments = path.split(".");
  return segments.length > 0 &&
    segments.every((segment) => segment.length > 0 && !FORBIDDEN_PATH_SEGMENTS.has(segment))
    ? segments
    : null;
}

export function parseFocusedSettingLookup(
  value: unknown,
  requestedPath: string,
): FocusedSettingLookup | null {
  const lookup = asRecord(value);
  const schema = asRecord(lookup?.schema);
  if (
    lookup?.path !== requestedPath ||
    !schema ||
    schema.type !== "boolean" ||
    (lookup.reloadKind !== undefined &&
      lookup.reloadKind !== "restart" &&
      lookup.reloadKind !== "hot" &&
      lookup.reloadKind !== "none")
  ) {
    return null;
  }
  return {
    path: requestedPath,
    schema: schema as JsonSchema,
    ...(lookup.reloadKind ? { reloadKind: lookup.reloadKind as FocusedSettingReloadKind } : {}),
    ...(asRecord(lookup.hint) ? { hint: lookup.hint as ConfigUiHint } : {}),
  };
}

export function focusedSettingValue(config: unknown, path: string): unknown {
  const segments = focusedSettingPathSegments(path);
  if (!segments) {
    return undefined;
  }
  let current = config;
  for (const segment of segments) {
    const record = asRecord(current);
    if (!record || !Object.hasOwn(record, segment)) {
      return undefined;
    }
    current = record[segment];
  }
  return current;
}

export function buildFocusedSettingPatch(
  path: string,
  value: boolean,
): Record<string, unknown> | null {
  const segments = focusedSettingPathSegments(path);
  if (!segments) {
    return null;
  }
  const patch: Record<string, unknown> = {};
  setPathValue(patch, segments, value);
  return patch;
}

function reloadDescription(kind: FocusedSettingReloadKind | undefined): string | null {
  switch (kind) {
    case "hot":
      return t("focusedSetting.reloadHot");
    case "restart":
      return t("focusedSetting.reloadRestart");
    case "none":
      return t("focusedSetting.reloadNone");
    default:
      return null;
  }
}

function renderUnavailable(message: string): TemplateResult {
  return renderSettingsPage(
    renderSettingsSection(
      { title: t("focusedSetting.title") },
      renderSettingsRow({
        title: t("focusedSetting.unavailableTitle"),
        description: html`<span role="alert">${message}</span>`,
      }),
    ),
  );
}

export function renderFocusedSetting(props: {
  path: string;
  state: FocusedSettingLookupState;
  config: unknown;
  pendingValue: boolean | null;
  saving: boolean;
  saved: boolean;
  saveError: string | null;
  canEdit: boolean;
  onChange: (enabled: boolean) => void;
}): TemplateResult {
  if (props.state.phase === "loading") {
    return renderSettingsPage(
      renderSettingsSection(
        { title: t("focusedSetting.title") },
        renderSettingsRow({
          title: t("common.loading"),
          description: t("focusedSetting.loadingDescription"),
        }),
      ),
    );
  }
  if (props.state.phase === "error") {
    return renderUnavailable(props.state.message);
  }

  const { lookup } = props.state;
  const current = focusedSettingValue(props.config, lookup.path);
  const checked =
    props.pendingValue ??
    (typeof current === "boolean"
      ? current
      : typeof lookup.schema.default === "boolean"
        ? lookup.schema.default
        : false);
  const reload = reloadDescription(lookup.reloadKind);
  const description = html`
    ${lookup.hint?.help ?? nothing} ${reload ? html`<span>${reload}</span>` : nothing}
    ${!props.canEdit ? html`<span>${t("focusedSetting.adminRequired")}</span>` : nothing}
  `;
  const rows = html`
    ${renderSettingsToggleRow({
      title: lookup.hint?.label ?? lookup.path,
      description,
      checked,
      disabled: !props.canEdit || props.saving,
      onChange: props.onChange,
    })}
    ${props.saving
      ? renderSettingsRow({
          title: t("focusedSetting.saving"),
          control: renderSettingsStatus({ kind: "accent", label: t("common.working") }),
        })
      : props.saveError
        ? renderSettingsRow({
            title: t("focusedSetting.saveFailed"),
            description: html`<span role="alert">${props.saveError}</span>`,
          })
        : props.saved
          ? renderSettingsRow({
              title: t("focusedSetting.saved"),
              control: renderSettingsStatus({ kind: "ok", label: t("focusedSetting.saved") }),
            })
          : nothing}
  `;
  return renderSettingsPage(
    renderSettingsSection(
      {
        title: t("focusedSetting.title"),
        description: html`${t("focusedSetting.pathLabel")} <code>${props.path}</code>`,
      },
      rows,
    ),
  );
}
