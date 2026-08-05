import type { RealtimeTalkTransportContext } from "./realtime-talk-shared.ts";

const RELAY_CLOSE_TIMEOUT_MS = 8_000;

export const closeGatewayRelayRealtimeTalkSession = (
  client: RealtimeTalkTransportContext["client"],
  relaySessionId: string,
): Promise<unknown> =>
  client.request(
    "talk.session.close",
    { sessionId: relaySessionId },
    { timeoutMs: RELAY_CLOSE_TIMEOUT_MS },
  );
