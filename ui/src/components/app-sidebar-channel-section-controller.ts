import { isSessionRouteId } from "../app-route-paths.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import type { SessionOrganizerController } from "./session-organizer-controller.ts";

type SidebarChannelSectionHost = {
  activeRouteId?: string;
  sessionOrganizer: SessionOrganizerController;
  findSidebarSessionByKey(sessionKey: string): SidebarRecentSession | undefined;
  getRouteSessionKey(): string;
  requestUpdate(): void;
};

/** Keeps default-collapsed channel chats reachable when one becomes active. */
export class SidebarChannelSectionController {
  private dismissedAutoExpandedKey: string | null = null;

  constructor(private readonly host: SidebarChannelSectionHost) {}

  get collapsedSections(): ReadonlySet<string> {
    const stored = this.host.sessionOrganizer.collapsedSessionSections;
    if (!stored.has("channels")) {
      return stored;
    }
    const activeKey = this.activeChannelKey();
    if (!activeKey || activeKey === this.dismissedAutoExpandedKey) {
      return stored;
    }
    const effective = new Set(stored);
    effective.delete("channels");
    return effective;
  }

  toggle(sectionId: string): void {
    if (sectionId !== "channels") {
      this.host.sessionOrganizer.toggleSection(sectionId);
      return;
    }
    const activeKey = this.activeChannelKey();
    const storedCollapsed = this.host.sessionOrganizer.collapsedSessionSections.has(sectionId);
    if (!this.collapsedSections.has(sectionId)) {
      this.dismissedAutoExpandedKey = activeKey;
      if (storedCollapsed) {
        this.host.requestUpdate();
      } else {
        this.host.sessionOrganizer.toggleSection(sectionId);
      }
      return;
    }
    this.dismissedAutoExpandedKey = null;
    this.host.sessionOrganizer.toggleSection(sectionId);
  }

  resetDismissedAutoExpansion(): void {
    this.dismissedAutoExpandedKey = null;
  }

  private activeChannelKey(): string | null {
    if (!isSessionRouteId(this.host.activeRouteId)) {
      return null;
    }
    const routeKey = this.host.getRouteSessionKey();
    return this.host.findSidebarSessionByKey(routeKey)?.channelSession ? routeKey : null;
  }
}
