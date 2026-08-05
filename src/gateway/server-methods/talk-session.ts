import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkSessionAppendAudioParams,
  validateTalkSessionCancelOutputParams,
  validateTalkSessionCancelTurnParams,
  validateTalkSessionCloseParams,
  validateTalkSessionJoinParams,
  validateTalkSessionSteerParams,
  validateTalkSessionSubmitToolResultParams,
  validateTalkSessionTurnParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import {
  cancelTalkHandoffTurn,
  endTalkHandoffTurn,
  getTalkHandoff,
  joinTalkHandoff,
  revokeTalkHandoff,
  startTalkHandoffTurn,
  type TalkHandoffTurnResult,
} from "../talk-handoff.js";
import {
  cancelTalkRealtimeRelayOutput,
  cancelTalkRealtimeRelayTurn,
  sendTalkRealtimeRelayAudio,
  steerTalkRealtimeRelayAgentRun,
  stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult,
} from "../talk-realtime-relay.js";
import {
  forgetUnifiedTalkSession,
  getUnifiedTalkSession,
  requireUnifiedTalkSessionConn,
  type UnifiedTalkSessionRecord,
} from "../talk-session-registry.js";
import {
  cancelTalkTranscriptionRelayTurn,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "../talk-transcription-relay.js";
import { createTalkSession } from "./talk-session-create.js";
import { acknowledgeTalkSessionMark } from "./talk-session-mark.js";
import { respondInvalidRequest, respondOk, respondUnavailable } from "./talk-session-response.js";
import { broadcastTalkRoomEvents, talkHandoffErrorCode } from "./talk-shared.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

/** Gateway-managed Talk sessions resolve public ids through connection-owned unified records. */
type ManagedRoomTalkSession = Extract<UnifiedTalkSessionRecord, { kind: "managed-room" }>;

function isActiveManagedRoomClient(
  session: { handoffId: string },
  connId: string | undefined,
): boolean {
  if (!connId) {
    return false;
  }
  const handoff = getTalkHandoff(session.handoffId);
  return handoff?.room.activeClientId === connId;
}

function canCloseManagedRoomSession(
  session: { handoffId: string },
  connId: string | undefined,
): boolean {
  const handoff = getTalkHandoff(session.handoffId);
  return !handoff?.room.activeClientId || handoff.room.activeClientId === connId;
}

function managedRoomOwnershipError(action: string) {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `talk.session.${action} requires the active managed-room connection`,
  );
}

function respondManagedRoomTurn(params: {
  session: UnifiedTalkSessionRecord;
  connId?: string;
  context: GatewayRequestContext;
  respond: RespondFn;
  method: "talk.session.startTurn" | "talk.session.endTurn" | "talk.session.cancelTurn";
  ownershipAction: "startTurn" | "endTurn" | "cancelTurn";
  failureVerb: "start" | "end" | "cancel";
  run: (session: ManagedRoomTalkSession) => TalkHandoffTurnResult;
}) {
  if (params.session.kind !== "managed-room") {
    respondInvalidRequest(params.respond, `${params.method} requires managed-room`);
    return;
  }
  if (!isActiveManagedRoomClient(params.session, params.connId)) {
    params.respond(false, undefined, managedRoomOwnershipError(params.ownershipAction));
    return;
  }
  const result = params.run(params.session);
  if (!result.ok) {
    params.respond(
      false,
      undefined,
      errorShape(
        talkHandoffErrorCode(result.reason),
        `talk turn ${params.failureVerb} failed: ${result.reason}`,
      ),
    );
    return;
  }
  broadcastTalkRoomEvents(params.context, result.record.room.activeClientId, {
    handoffId: result.record.id,
    roomId: result.record.roomId,
    events: result.events,
  });
  respondOk(params.respond, { ok: true, turnId: result.turnId, events: result.events });
}

/** RPC handlers for gateway-managed Talk sessions and room lifecycle. */
export const talkSessionHandlers: GatewayRequestHandlers = {
  "talk.session.create": createTalkSession,
  "talk.session.join": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateTalkSessionJoinParams, "talk.session.join", respond)) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind !== "managed-room") {
        respondInvalidRequest(respond, "talk.session.join requires a managed-room session");
        return;
      }
      const result = joinTalkHandoff(session.handoffId, params.token, { clientId: client?.connId });
      if (!result.ok) {
        respond(
          false,
          undefined,
          errorShape(
            result.reason === "invalid_token" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
            `talk session join failed: ${result.reason}`,
          ),
        );
        return;
      }
      broadcastTalkRoomEvents(context, result.replacedClientId, {
        handoffId: result.record.id,
        roomId: result.record.roomId,
        events: result.replacementEvents,
      });
      broadcastTalkRoomEvents(context, client?.connId, {
        handoffId: result.record.id,
        roomId: result.record.roomId,
        events: result.activeClientEvents,
      });
      respondOk(respond, result.record);
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
  "talk.session.appendAudio": async ({ params, respond, client }) => {
    if (
      !assertValidParams(
        params,
        validateTalkSessionAppendAudioParams,
        "talk.session.appendAudio",
        respond,
      )
    ) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        sendTalkRealtimeRelayAudio({
          relaySessionId: session.relaySessionId,
          connId,
          audioBase64: params.audioBase64,
          timestamp: params.timestamp,
        });
        respondOk(respond);
        return;
      }
      if (session.kind === "transcription-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        sendTalkTranscriptionRelayAudio({
          transcriptionSessionId: session.transcriptionSessionId,
          connId,
          audioBase64: params.audioBase64,
        });
        respondOk(respond);
        return;
      }
      respondInvalidRequest(
        respond,
        "talk.session.appendAudio is not supported for managed-room sessions",
      );
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
  "talk.session.startTurn": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(params, validateTalkSessionTurnParams, "talk.session.startTurn", respond)
    ) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      respondManagedRoomTurn({
        session,
        connId: client?.connId,
        context,
        respond,
        method: "talk.session.startTurn",
        ownershipAction: "startTurn",
        failureVerb: "start",
        run: (managedSession) =>
          startTalkHandoffTurn(managedSession.handoffId, managedSession.token, {
            turnId: params.turnId,
            clientId: client?.connId,
          }),
      });
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
  "talk.session.endTurn": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(params, validateTalkSessionTurnParams, "talk.session.endTurn", respond)
    ) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      respondManagedRoomTurn({
        session,
        connId: client?.connId,
        context,
        respond,
        method: "talk.session.endTurn",
        ownershipAction: "endTurn",
        failureVerb: "end",
        run: (managedSession) =>
          endTalkHandoffTurn(managedSession.handoffId, managedSession.token, {
            turnId: params.turnId,
          }),
      });
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
  "talk.session.cancelTurn": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(
        params,
        validateTalkSessionCancelTurnParams,
        "talk.session.cancelTurn",
        respond,
      )
    ) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        cancelTalkRealtimeRelayTurn({
          relaySessionId: session.relaySessionId,
          connId,
          reason: normalizeOptionalString(params.reason),
        });
        respondOk(respond);
        return;
      }
      if (session.kind === "transcription-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        cancelTalkTranscriptionRelayTurn({
          transcriptionSessionId: session.transcriptionSessionId,
          connId,
          reason: normalizeOptionalString(params.reason),
        });
        respondOk(respond);
        return;
      }
      respondManagedRoomTurn({
        session,
        connId: client?.connId,
        context,
        respond,
        method: "talk.session.cancelTurn",
        ownershipAction: "cancelTurn",
        failureVerb: "cancel",
        run: (managedSession) =>
          cancelTalkHandoffTurn(managedSession.handoffId, managedSession.token, {
            turnId: params.turnId,
            reason: params.reason,
          }),
      });
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
  "talk.session.cancelOutput": async ({ params, respond, client }) => {
    if (
      !assertValidParams(
        params,
        validateTalkSessionCancelOutputParams,
        "talk.session.cancelOutput",
        respond,
      )
    ) {
      return;
    }
    if (params.outputGeneration === undefined) {
      respondInvalidRequest(
        respond,
        "talk.session.cancelOutput requires outputGeneration; upgrade the client before retrying output cancellation",
      );
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind !== "realtime-relay") {
        respondInvalidRequest(respond, "talk.session.cancelOutput requires realtime relay");
        return;
      }
      const connId = requireUnifiedTalkSessionConn(session, client?.connId);
      cancelTalkRealtimeRelayOutput({
        relaySessionId: session.relaySessionId,
        connId,
        turnId: normalizeOptionalString(params.turnId),
        outputGeneration: params.outputGeneration,
        reason: normalizeOptionalString(params.reason) ?? "output-cancelled",
      });
      respondOk(respond);
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
  "talk.session.acknowledgeMark": acknowledgeTalkSessionMark,
  "talk.session.submitToolResult": async ({ params, respond, client }) => {
    if (
      !assertValidParams(
        params,
        validateTalkSessionSubmitToolResultParams,
        "talk.session.submitToolResult",
        respond,
      )
    ) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind !== "realtime-relay") {
        respondInvalidRequest(
          respond,
          "talk.session.submitToolResult is only supported for realtime relay sessions",
        );
        return;
      }
      const connId = requireUnifiedTalkSessionConn(session, client?.connId);
      await submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId,
        callId: params.callId,
        result: params.result,
        options: params.options,
      });
      respondOk(respond);
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
  "talk.session.steer": async ({ params, respond, client }) => {
    if (!assertValidParams(params, validateTalkSessionSteerParams, "talk.session.steer", respond)) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        const result = await steerTalkRealtimeRelayAgentRun({
          relaySessionId: session.relaySessionId,
          connId,
          sessionKey: normalizeOptionalString(params.sessionKey),
          text: params.text,
          mode: normalizeOptionalString(params.mode),
        });
        respondOk(respond, result);
        return;
      }
      if (session.kind === "transcription-relay") {
        respondInvalidRequest(respond, "talk.session.steer requires an agent-backed Talk session");
        return;
      }
      if (!isActiveManagedRoomClient(session, client?.connId)) {
        respond(false, undefined, managedRoomOwnershipError("steer"));
        return;
      }
      const handoff = getTalkHandoff(session.handoffId);
      const sessionKey = handoff?.sessionKey;
      if (!sessionKey) {
        respondInvalidRequest(respond, "talk.session.steer requires a session key");
        return;
      }
      const requestedSessionKey = normalizeOptionalString(params.sessionKey);
      if (requestedSessionKey && requestedSessionKey !== sessionKey) {
        respondInvalidRequest(
          respond,
          "talk.session.steer sessionKey does not match the managed-room session",
        );
        return;
      }
      const result = await controlRealtimeVoiceAgentRun({
        sessionKey,
        text: params.text,
        mode: params.mode,
        recentEvents: handoff?.room.talk.recentEvents,
      });
      respondOk(respond, result);
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
  "talk.session.close": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateTalkSessionCloseParams, "talk.session.close", respond)) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId });
      } else if (session.kind === "transcription-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        stopTalkTranscriptionRelaySession({
          transcriptionSessionId: session.transcriptionSessionId,
          connId,
        });
      } else {
        if (!canCloseManagedRoomSession(session, client?.connId)) {
          respond(false, undefined, managedRoomOwnershipError("close"));
          return;
        }
        const result = revokeTalkHandoff(session.handoffId);
        broadcastTalkRoomEvents(context, result.activeClientId, {
          handoffId: session.handoffId,
          roomId: session.roomId,
          events: result.events,
        });
      }
      forgetUnifiedTalkSession(params.sessionId);
      respondOk(respond);
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
};
