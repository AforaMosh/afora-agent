import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Media metadata alone is not an attachment; provider emitters need inline bytes. */
export function hasMediaPayload(
  block: unknown,
): block is Record<string, unknown> & { data: string } {
  return isRecord(block) && typeof block.data === "string" && block.data.trim().length > 0;
}
