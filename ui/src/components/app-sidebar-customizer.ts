import { html, nothing, type TemplateResult } from "lit";
import {
  navigationIconForRoute,
  parseSidebarEntry,
  serializeSidebarEntry,
  SIDEBAR_NAV_ROUTES,
  titleForRoute,
  type NavigationRouteId,
} from "../app-navigation.ts";
import { t } from "../i18n/index.ts";
import type { SessionMethodAccess } from "../lib/session-method-access.ts";
import { writeSidebarSectionDragData } from "../lib/sessions/drag.ts";
import type { SidebarVisibleSections } from "./app-sidebar-session-navigation-logic.ts";
import type { SidebarWorkboardBoard } from "./app-sidebar-workboard.ts";
import { icons } from "./icons.ts";

export type SidebarCustomizerItem = {
  id: string;
  label: string;
  icon?: TemplateResult;
  visible: boolean;
  kind: "entry" | "section";
  entry?: string;
  category?: string;
  reorderable?: boolean;
  toggleable?: boolean;
  sessionKey?: string;
};

export type SidebarCustomizerValue = {
  sidebarEntries: readonly string[];
  hiddenCatalogIds: readonly string[];
  groups: readonly string[];
  sectionOrder: readonly string[];
};

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sidebarCustomizerValuesEqual(
  left: SidebarCustomizerValue,
  right: SidebarCustomizerValue,
): boolean {
  return (
    equalStringArrays(left.sidebarEntries, right.sidebarEntries) &&
    equalStringArrays(left.hiddenCatalogIds, right.hiddenCatalogIds) &&
    equalStringArrays(left.groups, right.groups) &&
    equalStringArrays(left.sectionOrder, right.sectionOrder)
  );
}

export function mergeSidebarCustomizerEntries(
  current: readonly string[],
  snapshot: readonly string[],
  customizable: readonly string[],
): string[] {
  const customizableEntries = new Set(customizable);
  const remaining = [...snapshot];
  const merged = current.flatMap((entry) => {
    if (!customizableEntries.has(entry)) {
      return [entry];
    }
    const replacement = remaining.shift();
    return replacement ? [replacement] : [];
  });
  return [...merged, ...remaining];
}

export function buildSidebarCustomizerEntries(params: {
  canonical: readonly string[];
  enabledRouteIds?: readonly NavigationRouteId[];
  pinnedSessions?: ReadonlyMap<string, { key: string; label: string }>;
  workboards: readonly SidebarWorkboardBoard[];
}): SidebarCustomizerItem[] {
  const order = new Map(params.canonical.map((entry, index) => [entry, index]));
  const items: Array<SidebarCustomizerItem & { fallbackIndex: number }> = [
    {
      id: "fixed:home",
      kind: "entry",
      label: t("nav.home"),
      icon: icons.home,
      visible: true,
      reorderable: false,
      toggleable: false,
      fallbackIndex: -1,
    },
    ...SIDEBAR_NAV_ROUTES.filter(
      (routeId) => params.enabledRouteIds?.includes(routeId) ?? true,
    ).map((routeId, fallbackIndex) => {
      const entry = serializeSidebarEntry({ type: "route", route: routeId });
      return {
        id: entry,
        entry,
        kind: "entry" as const,
        label: titleForRoute(routeId),
        icon: icons[navigationIconForRoute(routeId)],
        visible: params.canonical.includes(entry),
        fallbackIndex,
      };
    }),
  ];
  const boardOffset = items.length;
  const workboards =
    (params.enabledRouteIds?.includes("workboard") ?? true) ? params.workboards : [];
  for (const [index, board] of workboards.entries()) {
    const entry = serializeSidebarEntry({ type: "workboard", boardId: board.id });
    items.push({
      id: entry,
      entry,
      kind: "entry",
      label: board.name?.trim() || board.id,
      icon: icons.layoutGrid,
      visible: params.canonical.includes(entry),
      fallbackIndex: boardOffset + index,
    });
  }
  for (const [index, entry] of params.canonical.entries()) {
    const parsed = parseSidebarEntry(entry);
    if (parsed?.type !== "session") {
      continue;
    }
    const session = params.pinnedSessions?.get(parsed.key);
    if (!session) {
      continue;
    }
    items.push({
      id: entry,
      entry,
      icon: icons.botMessageSquare,
      kind: "entry",
      label: session.label.trim() || session.key,
      sessionKey: session.key,
      visible: true,
      fallbackIndex: boardOffset + workboards.length + index,
    });
  }
  return items.toSorted((a, b) => {
    if (a.id === "fixed:home" || b.id === "fixed:home") {
      return a.id === "fixed:home" ? -1 : 1;
    }
    const aIndex = order.get(a.entry!);
    const bIndex = order.get(b.entry!);
    if (aIndex !== undefined && bIndex !== undefined) {
      return aIndex - bIndex;
    }
    if (aIndex !== undefined) {
      return -1;
    }
    if (bIndex !== undefined) {
      return 1;
    }
    return a.fallbackIndex - b.fallbackIndex;
  });
}

export function buildSidebarCustomizerSections(params: {
  sections: SidebarVisibleSections["sections"];
  catalogLabels: ReadonlyMap<string, string>;
  hiddenCatalogIds: ReadonlySet<string>;
}): SidebarCustomizerItem[] {
  return params.sections.map((section) => {
    const catalogId = section.id.startsWith("catalog:")
      ? section.id.slice("catalog:".length)
      : null;
    return {
      id: section.id,
      label: catalogId
        ? (params.catalogLabels.get(catalogId) ?? catalogId)
        : section.groups
          ? t("chat.sidebar.groups")
          : section.work
            ? t("chat.sidebar.coding")
            : section.category
              ? section.category
              : t("chat.sidebar.threads"),
      kind: "section",
      category: section.category,
      visible: catalogId ? !params.hiddenCatalogIds.has(catalogId) : true,
      reorderable: true,
      toggleable: catalogId !== null,
    };
  });
}

type SidebarCustomizerParams = {
  entries: readonly SidebarCustomizerItem[];
  sections: readonly SidebarCustomizerItem[];
  entryDropTarget: { entry: string; position: "before" | "after" } | null;
  sectionDropTarget: { sectionId: string; position: "before" | "after" } | null;
  dirty: boolean;
  error: string | null;
  onToggle: (item: SidebarCustomizerItem) => void;
  onRemove: (item: SidebarCustomizerItem) => void;
  onMove: (
    item: SidebarCustomizerItem,
    items: readonly SidebarCustomizerItem[],
    direction: "up" | "down",
  ) => void;
  onDone: () => void;
  onBack: () => void;
  onEntryDragStart: (event: DragEvent, item: SidebarCustomizerItem) => void;
  onEntryDragOver: (event: DragEvent, entry: string) => void;
  onEntryDragLeave: (event: DragEvent) => void;
  onEntryDrop: (event: DragEvent, entry: string) => void;
  onSectionDragStart: (sectionId: string) => void;
  onSectionDragOver: (event: DragEvent, sectionId: string, category?: string) => void;
  onSectionDragLeave: (event: DragEvent, sectionId: string, category?: string) => void;
  onSectionDrop: (event: DragEvent, sectionId: string, category?: string) => void;
  onDragEnd: (kind: SidebarCustomizerItem["kind"]) => void;
  sectionReorderAccess: SessionMethodAccess;
  sessionPatchAccess: SessionMethodAccess;
};

function renderCustomizerItem(
  item: SidebarCustomizerItem,
  params: SidebarCustomizerParams,
  index: number,
) {
  const toggleable = item.toggleable !== false;
  const reorderable =
    item.reorderable !== false && (item.kind === "section" || (toggleable && item.visible));
  const reorderAccess =
    item.kind === "section" ? params.sectionReorderAccess : ({ allowed: true } as const);
  const draggable = reorderable && reorderAccess.allowed;
  const siblings = item.kind === "section" ? params.sections : params.entries;
  const movable = siblings.filter(
    (candidate) =>
      candidate.reorderable !== false &&
      (candidate.kind === "section" || candidate.visible) &&
      candidate.kind === item.kind,
  );
  const movableIndex = movable.findIndex((candidate) => candidate.id === item.id);
  const showVisibilityControl = toggleable;
  const removable = item.sessionKey !== undefined;
  const dropPosition =
    item.kind === "section"
      ? params.sectionDropTarget?.sectionId === item.id
        ? params.sectionDropTarget.position
        : null
      : item.entry && params.entryDropTarget?.entry === item.entry
        ? params.entryDropTarget.position
        : null;
  const visibilityLabel = t(item.visible ? "nav.customizeHide" : "nav.customizeShow", {
    item: item.label,
  });
  return html`
    <div
      class="sidebar-customizer__row ${item.visible
        ? ""
        : "sidebar-customizer__row--hidden"} ${!draggable
        ? "sidebar-customizer__row--fixed"
        : ""} ${!toggleable && item.kind === "entry"
        ? "sidebar-customizer__row--disabled"
        : ""} ${item.kind === "section" ? "sidebar-customizer__row--section" : ""} ${dropPosition
        ? `sidebar-customizer__row--drop-${dropPosition}`
        : ""}"
      role="listitem"
      draggable=${draggable ? "true" : "false"}
      style=${`--sidebar-customizer-index: ${index}`}
      data-sidebar-customizer-id=${item.id}
      data-session-section=${item.kind === "section" ? item.id : ""}
      title=${!reorderAccess.allowed ? reorderAccess.reason : ""}
      @dragstart=${(event: DragEvent) => {
        if (!draggable || !event.dataTransfer) {
          event.preventDefault();
          return;
        }
        if (item.kind === "section") {
          writeSidebarSectionDragData(event.dataTransfer, item.id);
          params.onSectionDragStart(item.id);
          return;
        }
        params.onEntryDragStart(event, item);
      }}
      @dragover=${(event: DragEvent) => {
        if (item.kind === "section" && draggable) {
          params.onSectionDragOver(event, item.id, item.category);
        } else if (item.entry) {
          params.onEntryDragOver(event, item.entry);
        }
      }}
      @dragleave=${(event: DragEvent) => {
        if (item.kind === "section" && draggable) {
          params.onSectionDragLeave(event, item.id, item.category);
        } else {
          params.onEntryDragLeave(event);
        }
      }}
      @drop=${(event: DragEvent) => {
        if (item.kind === "section" && draggable) {
          params.onSectionDrop(event, item.id, item.category);
        } else if (item.entry) {
          params.onEntryDrop(event, item.entry);
        }
      }}
      @dragend=${() => params.onDragEnd(item.kind)}
    >
      ${draggable
        ? html`<span class="sidebar-customizer__grip" aria-hidden="true"
            >${icons.gripVertical}</span
          >`
        : nothing}
      ${item.icon
        ? html`<span class="sidebar-customizer__item-icon" aria-hidden="true">${item.icon}</span>`
        : nothing}
      <span
        class="sidebar-customizer__label ${item.kind === "section"
          ? "sidebar-customizer__label--section"
          : ""}"
        >${item.label}</span
      >
      ${reorderable
        ? html`<span class="sidebar-customizer__move-actions">
            ${(["up", "down"] as const).map((direction) => {
              const atBoundary =
                direction === "up" ? movableIndex <= 0 : movableIndex === movable.length - 1;
              const label = t(
                direction === "up" ? "nav.customizeMoveUp" : "nav.customizeMoveDown",
                { item: item.label },
              );
              return html`<button
                type="button"
                class="sidebar-customizer__move"
                aria-label=${label}
                title=${reorderAccess.allowed ? label : reorderAccess.reason}
                ?disabled=${atBoundary || !reorderAccess.allowed}
                @click=${() => params.onMove(item, siblings, direction)}
              >
                ${direction === "up" ? icons.chevronUp : icons.chevronDown}
              </button>`;
            })}
          </span>`
        : nothing}
      ${removable
        ? html`<button
            type="button"
            class="sidebar-customizer__visibility sidebar-customizer__remove"
            aria-label=${`${t("sessionsView.unpinSession")}: ${item.label}`}
            title=${params.sessionPatchAccess.allowed
              ? `${t("sessionsView.unpinSession")}: ${item.label}`
              : params.sessionPatchAccess.reason}
            ?disabled=${!params.sessionPatchAccess.allowed}
            @mousedown=${(event: MouseEvent) => event.stopPropagation()}
            @click=${() => params.onRemove(item)}
          >
            ${icons.pinOff}
          </button>`
        : showVisibilityControl
          ? html`<button
              type="button"
              class="sidebar-customizer__visibility"
              aria-label=${visibilityLabel}
              aria-pressed=${String(item.visible)}
              ?disabled=${!toggleable}
              title=${toggleable ? visibilityLabel : ""}
              @mousedown=${(event: MouseEvent) => event.stopPropagation()}
              @click=${() => {
                if (toggleable) {
                  params.onToggle(item);
                }
              }}
            >
              ${item.visible ? icons.eye : icons.eyeOff}
            </button>`
          : nothing}
    </div>
  `;
}

export function renderSidebarCustomizer(params: SidebarCustomizerParams) {
  return html`
    <section
      class="sidebar-customizer"
      aria-label=${t("nav.customize")}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          params.onBack();
        }
      }}
    >
      <div class="sidebar-customizer__scroll">
        <div class="sidebar-customizer__list" role="list">
          ${params.entries.map((item, index) => renderCustomizerItem(item, params, index))}
        </div>
        <div class="sidebar-customizer__separator" role="separator"></div>
        <div class="sidebar-customizer__list" role="list">
          ${params.sections.map((item, index) =>
            renderCustomizerItem(item, params, params.entries.length + index),
          )}
        </div>
      </div>
      ${params.error
        ? html`<div class="sidebar-customizer__error" role="alert">${params.error}</div>`
        : nothing}
      <div class="sidebar-customizer__footer">
        <button type="button" class="btn primary sidebar-customizer__done" @click=${params.onDone}>
          ${t("nav.customizeDone")}
        </button>
        <button type="button" class="btn sidebar-customizer__back" @click=${params.onBack}>
          ${params.dirty ? t("nav.customizeDiscard") : t("common.back")}
        </button>
      </div>
    </section>
  `;
}
