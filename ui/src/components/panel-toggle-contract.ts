import type { UiCommandParams } from "@afora/gateway-protocol";

export const TERMINAL_PANEL_TOGGLE_EVENT = "afora:terminal-toggle";
export const TERMINAL_PANEL_DOCK_BOTTOM_EVENT = "afora:terminal-dock-bottom";
export const BROWSER_PANEL_TOGGLE_EVENT = "afora:browser-toggle";
export const DESKTOP_PANEL_TOGGLE_EVENT = "afora:desktop-toggle";
export const UI_COMMAND_EVENT = "afora:ui-command";

export type UiCommandDetail = UiCommandParams;

export type TerminalPanelToggleDetail = {
  agentId?: string | null;
  dock?: "bottom" | "right";
  open?: boolean;
  terminalSessionId?: string;
  catalog?: {
    catalogId: string;
    hostId: string;
    threadId: string;
  };
};

export type BrowserPanelToggleDetail = {
  dock?: "bottom" | "right";
  newTab?: boolean;
  open?: boolean;
  url?: string;
};

export type DesktopPanelToggleDetail = {
  dock?: "bottom" | "right";
  open?: boolean;
  environmentId?: string;
};

export type PanelToggleElement = HTMLElement & {
  handleToggleRequest: (event: Event) => void;
};

export function isTerminalPanelShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && event.code === "Backquote";
}
