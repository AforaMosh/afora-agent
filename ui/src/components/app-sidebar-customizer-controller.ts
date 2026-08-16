import type { ReactiveControllerHost } from "lit";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { showToast } from "../lib/toast.ts";
import {
  mergeSidebarCustomizerEntries,
  sidebarCustomizerValuesEqual,
  type SidebarCustomizerItem,
  type SidebarCustomizerValue,
} from "./app-sidebar-customizer.ts";
import {
  setStoredSessionCatalogHidden,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";
import type { SessionOrganizerController } from "./session-organizer-controller.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.ts";

type SidebarCustomizerSnapshot = SidebarCustomizerValue & {
  customizableSidebarEntries: readonly string[];
  pinnedSessions: readonly SidebarRecentSession[];
};

type SidebarCustomizerHost = ReactiveControllerHost &
  HTMLElement & {
    readonly hiddenSessionCatalogIds: ReadonlySet<string>;
    readonly onUpdateSidebarEntries?: (entries: string[]) => void;
    readonly sessionOrganizer: Pick<
      SessionOrganizerController,
      "patchSession" | "reorderSidebarSection"
    >;
    readonly sidebarMenus: Pick<SidebarMenusController, "dismissTransientMenus">;
    readonly updateComplete: Promise<boolean>;
    findSidebarSessionByKey(sessionKey: string): SidebarRecentSession | undefined;
    knownSectionOrder(): string[];
    reconciledSidebarZone(): { sidebarEntries: readonly string[] };
    sidebarCustomizerContext(): ApplicationContext<RouteId> | undefined;
    sidebarCustomizerEntries(): SidebarCustomizerItem[];
  };

export class SidebarCustomizerController {
  isOpen = false;
  error: string | null = null;

  private returnFocus: HTMLElement | null = null;
  private snapshot: SidebarCustomizerSnapshot | null = null;
  private readonly pendingMutations = new Set<Promise<unknown>>();
  private restoring = false;

  constructor(private readonly host: SidebarCustomizerHost) {}

  open(trigger: HTMLElement | null = null): void {
    this.host.sidebarMenus.dismissTransientMenus();
    this.returnFocus = trigger;
    void this.openAfterGroupLoad();
  }

  private async openAfterGroupLoad(): Promise<void> {
    const sessions = this.host.sidebarCustomizerContext()?.sessions;
    const groups = await sessions?.groupsLoad();
    if (groups === null || sessions !== this.host.sidebarCustomizerContext()?.sessions) {
      this.reportError("nav.customizeMutationError");
      return;
    }
    const entries = this.host.sidebarCustomizerEntries();
    this.snapshot = {
      ...this.value(entries),
      customizableSidebarEntries: entries.flatMap((item) => (item.entry ? [item.entry] : [])),
      pinnedSessions: entries.flatMap((item) => {
        const session = item.sessionKey
          ? this.host.findSidebarSessionByKey(item.sessionKey)
          : undefined;
        return session ? [session] : [];
      }),
    };
    this.error = null;
    this.isOpen = true;
    this.host.requestUpdate();
    void this.host.updateComplete.then(() =>
      this.host.querySelector<HTMLElement>(".sidebar-customizer button:not([disabled])")?.focus(),
    );
  }

  close(): void {
    this.isOpen = false;
    this.error = null;
    this.snapshot = null;
    this.restoring = false;
    const returnFocus = this.returnFocus;
    this.returnFocus = null;
    this.host.requestUpdate();
    void this.host.updateComplete.then(() => {
      if (returnFocus?.isConnected) {
        returnFocus.focus();
      } else {
        this.host.querySelector<HTMLElement>(".sidebar-nav__more")?.focus();
      }
    });
  }

  private reportError(key: "nav.customizeMutationError" | "nav.customizeRestoreError"): void {
    this.error = t(key);
    this.host.requestUpdate();
    showToast({ message: this.error });
  }

  async discard(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) {
      this.close();
      return;
    }
    if (this.restoring) {
      return;
    }
    if (this.pendingMutations.size === 0 && !this.isDirty()) {
      this.close();
      return;
    }
    this.restoring = true;
    this.host.requestUpdate();
    await Promise.allSettled([...this.pendingMutations]);
    let failureCount = 0;
    try {
      if (this.host.onUpdateSidebarEntries) {
        this.host.onUpdateSidebarEntries(
          mergeSidebarCustomizerEntries(
            this.host.reconciledSidebarZone().sidebarEntries,
            snapshot.sidebarEntries,
            snapshot.customizableSidebarEntries,
          ),
        );
      } else {
        failureCount += 1;
      }
    } catch {
      failureCount += 1;
    }
    const snapshotHiddenCatalogIds = new Set(snapshot.hiddenCatalogIds);
    const catalogIds = new Set([
      ...this.host.hiddenSessionCatalogIds,
      ...snapshot.hiddenCatalogIds,
    ]);
    for (const catalogId of catalogIds) {
      try {
        setStoredSessionCatalogHidden(catalogId, snapshotHiddenCatalogIds.has(catalogId));
      } catch {
        failureCount += 1;
      }
    }
    for (const snapshotSession of snapshot.pinnedSessions) {
      const currentSession = this.host.findSidebarSessionByKey(snapshotSession.key);
      if (!currentSession?.pinned) {
        const outcome = await this.host.sessionOrganizer.patchSession(snapshotSession, {
          pinned: true,
        });
        if (outcome !== "completed") {
          failureCount += 1;
        }
      }
    }
    const sessions = this.host.sidebarCustomizerContext()?.sessions;
    if (sessions) {
      try {
        const outcome = await sessions.groupsPut([...snapshot.groups], [...snapshot.sectionOrder]);
        if (outcome !== "completed") {
          failureCount += 1;
        }
      } catch {
        failureCount += 1;
      }
    } else {
      failureCount += 1;
    }
    if (failureCount > 0) {
      this.restoring = false;
      this.reportError("nav.customizeRestoreError");
    } else {
      this.close();
    }
  }

  private value(
    entries: readonly SidebarCustomizerItem[] = this.host.sidebarCustomizerEntries(),
  ): SidebarCustomizerValue {
    return {
      sidebarEntries: entries.flatMap((item) => (item.entry && item.visible ? [item.entry] : [])),
      hiddenCatalogIds: [...this.host.hiddenSessionCatalogIds].toSorted(),
      groups: [...(this.host.sidebarCustomizerContext()?.sessions.state.groups ?? [])],
      sectionOrder: this.host.knownSectionOrder(),
    };
  }

  isDirty(
    entries: readonly SidebarCustomizerItem[] = this.host.sidebarCustomizerEntries(),
  ): boolean {
    return this.snapshot
      ? !sidebarCustomizerValuesEqual(this.value(entries), this.snapshot)
      : false;
  }

  toggle(item: SidebarCustomizerItem): void {
    if (item.kind === "entry" && item.entry) {
      if (!this.host.onUpdateSidebarEntries) {
        this.reportError("nav.customizeMutationError");
        return;
      }
      const canonical = this.host.reconciledSidebarZone().sidebarEntries;
      const next = canonical.includes(item.entry)
        ? canonical.filter((candidate) => candidate !== item.entry)
        : [...canonical, item.entry];
      this.host.onUpdateSidebarEntries(next);
      this.clearError();
      return;
    }
    if (item.id.startsWith("catalog:")) {
      try {
        setStoredSessionCatalogHidden(item.id.slice("catalog:".length), item.visible);
        this.clearError();
      } catch {
        this.reportError("nav.customizeMutationError");
      }
    }
  }

  remove(item: SidebarCustomizerItem): void {
    if (!item.sessionKey || this.restoring) {
      return;
    }
    const session = this.host.findSidebarSessionByKey(item.sessionKey);
    if (!session) {
      this.reportError("nav.customizeMutationError");
      return;
    }
    this.trackMutationOutcome(this.host.sessionOrganizer.patchSession(session, { pinned: false }));
  }

  move(
    item: SidebarCustomizerItem,
    items: readonly SidebarCustomizerItem[],
    direction: "up" | "down",
  ): void {
    if (this.restoring) {
      return;
    }
    const movable = items.filter(
      (candidate) =>
        candidate.reorderable !== false &&
        (candidate.kind === "section" || candidate.visible) &&
        candidate.kind === item.kind,
    );
    const index = movable.findIndex((candidate) => candidate.id === item.id);
    const target = movable[index + (direction === "up" ? -1 : 1)];
    if (!target) {
      return;
    }
    if (item.kind === "section") {
      this.trackSectionMutation(
        this.host.sessionOrganizer.reorderSidebarSection(
          item.id,
          target.id,
          direction === "up" ? "before" : "after",
        ),
      );
      return;
    }
    if (!item.entry || !target.entry || !this.host.onUpdateSidebarEntries) {
      this.reportError("nav.customizeMutationError");
      return;
    }
    const next = this.host
      .reconciledSidebarZone()
      .sidebarEntries.filter((entry) => entry !== item.entry);
    const targetIndex = next.indexOf(target.entry);
    next.splice(targetIndex + (direction === "down" ? 1 : 0), 0, item.entry);
    this.host.onUpdateSidebarEntries(next);
    this.clearError();
  }

  trackSectionMutation(mutation: Promise<"completed" | "failed" | "stale">): void {
    this.trackMutationOutcome(mutation);
  }

  private trackMutationOutcome(mutation: Promise<"completed" | "failed" | "stale">): void {
    void this.trackMutation(mutation).then((outcome) => {
      if (outcome === "completed") {
        this.clearError();
      } else if (this.isOpen) {
        this.reportError("nav.customizeMutationError");
      }
    });
  }

  private trackMutation<T>(mutation: Promise<T>): Promise<T> {
    const tracked = mutation.finally(() => this.pendingMutations.delete(tracked));
    this.pendingMutations.add(tracked);
    return tracked;
  }

  clearError(): void {
    if (this.error !== null) {
      this.error = null;
      this.host.requestUpdate();
    }
  }
}
