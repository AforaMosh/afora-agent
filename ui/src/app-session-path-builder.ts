import type { ControlUiSessionNamespace } from "@afora/session-url-contract";

type SessionPathDetails = {
  displayName?: string | null;
  exactKey?: boolean;
  mainKey?: string | null;
  shortIdLength?: number;
};

type SessionPathBuilder = typeof import("@afora/session-url-contract").buildControlUiSessionPath;

let builder: SessionPathBuilder | undefined;

export function setSessionPathBuilder(next: SessionPathBuilder): void {
  builder = next;
}

export function pathForSession(
  face: ControlUiSessionNamespace,
  agentId: string,
  sessionKey: string,
  basePath = "",
  details: SessionPathDetails = {},
): string | null {
  return (
    builder?.({
      namespace: face,
      sessionKey,
      fallbackAgentId: agentId,
      basePath,
      displayName: details.displayName ?? undefined,
      exactKey: details.exactKey,
      mainKey: details.mainKey ?? undefined,
      shortIdLength: details.shortIdLength,
    }) ?? null
  );
}
