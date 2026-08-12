const DESKTOP_CREDENTIALS_REQUIRED_CODE = "DESKTOP_CREDENTIALS_REQUIRED";

/** Reads the host-observe retry contract without exposing credential material. */
export function desktopCredentialRequirement(error: unknown): "ard-account" | null {
  if (!error || typeof error !== "object" || !("details" in error)) {
    return null;
  }
  const details = error.details;
  if (!details || typeof details !== "object") {
    return null;
  }
  return "code" in details &&
    details.code === DESKTOP_CREDENTIALS_REQUIRED_CODE &&
    "auth" in details &&
    details.auth === "ard-account"
    ? "ard-account"
    : null;
}
