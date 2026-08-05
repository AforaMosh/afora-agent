import { validateTalkSessionAcknowledgeMarkParams } from "../../../packages/gateway-protocol/src/index.js";
import { acknowledgeTalkRealtimeRelayMark } from "../talk-realtime-relay.js";
import { getUnifiedTalkSession, requireUnifiedTalkSessionConn } from "../talk-session-registry.js";
import { respondInvalidRequest, respondOk, respondUnavailable } from "./talk-session-response.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

export const acknowledgeTalkSessionMark: GatewayRequestHandler = ({ params, respond, client }) => {
  if (
    !assertValidParams(
      params,
      validateTalkSessionAcknowledgeMarkParams,
      "talk.session.acknowledgeMark",
      respond,
    )
  ) {
    return;
  }
  try {
    const session = getUnifiedTalkSession(params.sessionId);
    if (session.kind !== "realtime-relay") {
      respondInvalidRequest(respond, "talk.session.acknowledgeMark requires realtime relay");
      return;
    }
    acknowledgeTalkRealtimeRelayMark({
      relaySessionId: session.relaySessionId,
      connId: requireUnifiedTalkSessionConn(session, client?.connId),
      markName: params.markName,
    });
    respondOk(respond);
  } catch (error) {
    respondUnavailable(respond, error);
  }
};
