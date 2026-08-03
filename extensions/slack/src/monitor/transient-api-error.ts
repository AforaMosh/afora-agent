// Slack plugin module owns retry classification for durable Web API operations.
import {
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  readErrorName,
} from "openclaw/plugin-sdk/error-runtime";
import { classifyTransientNetworkErrorCode } from "openclaw/plugin-sdk/retry-runtime";

export function isTransientSlackApiError(error: unknown): boolean {
  if (error instanceof WebAPIPlatformError) {
    // Slack converts successful HTTP responses into platform errors after its request retries.
    return error.data.error === "internal_error";
  }
  if (error instanceof WebAPIRateLimitedError) {
    return true;
  }
  if (error instanceof WebAPIHTTPError) {
    return (
      error.statusCode === 408 ||
      error.statusCode === 429 ||
      (error.statusCode >= 500 && error.statusCode < 600)
    );
  }
  if (!(error instanceof WebAPIRequestError)) {
    return false;
  }
  const candidates = collectErrorGraphCandidates(error.original, (current) => [
    current.cause,
    current.error,
    current.original,
  ]);
  if (candidates.some((candidate) => readErrorName(candidate) === "AbortError")) {
    return false;
  }
  if (
    candidates.some(
      (candidate) =>
        readErrorName(candidate) === "TimeoutError" ||
        classifyTransientNetworkErrorCode(extractErrorCode(candidate)),
    )
  ) {
    return true;
  }
  // Exhausted rate limits become uncoded plain Errors; broken config and fetches keep
  // a structured error code or TypeError, so retrying them would block the whole lane.
  return !candidates.some(
    (candidate) =>
      readErrorName(candidate) === "TypeError" || Boolean(extractErrorCode(candidate)?.trim()),
  );
}
