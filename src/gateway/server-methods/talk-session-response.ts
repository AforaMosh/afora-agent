import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { formatForLog } from "../ws-log.js";
import type { RespondFn } from "./types.js";

export function respondInvalidRequest(respond: RespondFn, message: string) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

export function respondUnavailable(respond: RespondFn, err: unknown) {
  const message = formatForLog(err);
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, message, {
      details: {
        talkIssue: {
          code: "realtime_unavailable",
          message,
          phase: "request",
        },
      },
    }),
  );
}

export const respondOk = (respond: RespondFn, payload: unknown = { ok: true }) =>
  respond(true, payload, undefined);
