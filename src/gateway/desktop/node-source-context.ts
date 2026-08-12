import type { NodeDesktopService } from "./node-source.js";

export const NODE_DESKTOP_SERVICE_CONTEXT = Symbol("openclaw.nodeDesktopService");

export function getNodeDesktopService<TContext extends object>(
  context: TContext,
): NodeDesktopService | undefined {
  return Reflect.get(context, NODE_DESKTOP_SERVICE_CONTEXT) as NodeDesktopService | undefined;
}
