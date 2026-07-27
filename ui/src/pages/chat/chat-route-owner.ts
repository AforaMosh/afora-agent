import { routeIdFromPath } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import { locationWithoutDraft, type SessionChatRouteData } from "./route-loader.ts";
import { findPane, type ChatSplitLayout } from "./split-layout.ts";

type OwnedChatRouteHost = {
  context: ApplicationContext;
  data: SessionChatRouteData;
  layout: ChatSplitLayout | undefined;
  isCurrentData: (data: SessionChatRouteData) => boolean;
  wasDraftConsumed: (data: SessionChatRouteData) => boolean;
  consumeDraft: (data: SessionChatRouteData) => void;
  syncRouteAgent: () => void;
  syncRouteToActivePane: () => void;
};

export function ownsChatRoute(context: ApplicationContext, face: BoardFace): boolean {
  // A cached destination can commit before Lit disconnects the old chat page.
  // Its canonicalization must not replace the newly selected browser route.
  return routeIdFromPath(window.location.pathname, context.basePath) === face;
}

export function canonicalizeOwnedChatRoute(
  context: ApplicationContext,
  data: SessionChatRouteData | undefined,
  face: BoardFace,
  isCurrent: () => boolean,
  wasDraftConsumed: () => boolean,
): boolean {
  if (data?.canonicalLocation) {
    if (ownsChatRoute(context, face)) {
      context.replace(face, data.canonicalLocation);
    }
    return true;
  }

  void data?.canonicalLocationReady?.then((location) => {
    if (location && isCurrent()) {
      context.replace(face, wasDraftConsumed() ? locationWithoutDraft(location) : location);
    }
  });
  return false;
}

export function queueOwnedChatDraft(
  isCurrent: () => boolean,
  needsConsumption: () => boolean,
  consume: () => void,
): void {
  // Route drafts are single-owner state; never let a retiring page hand one
  // to a pane after a newly selected route has already committed.
  queueMicrotask(() => {
    if (isCurrent() && needsConsumption()) {
      consume();
    }
  });
}

export function updateOwnedChatRoute(
  host: OwnedChatRouteHost,
  changedProperties: Map<PropertyKey, unknown>,
): void {
  const { context, data, layout } = host;
  const face = data?.face ?? "chat";
  const isCurrent = () => host.isCurrentData(data) && ownsChatRoute(context, face);
  const activePane = layout ? findPane(layout, layout.activePaneId)?.pane : null;
  const routeDraftWasRendered =
    Boolean(data?.draft) &&
    !host.wasDraftConsumed(data) &&
    (!layout || activePane?.sessionKey === data.sessionKey);

  if (changedProperties.has("data")) {
    if (
      canonicalizeOwnedChatRoute(context, data, face, isCurrent, () => host.wasDraftConsumed(data))
    ) {
      return;
    }
    host.syncRouteAgent();
    host.syncRouteToActivePane();
  }
  if (data && routeDraftWasRendered) {
    queueOwnedChatDraft(
      isCurrent,
      () => !host.wasDraftConsumed(data),
      () => host.consumeDraft(data),
    );
  }
}
