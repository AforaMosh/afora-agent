import { ErrorCodes, GatewayErrorDetailCodes } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { FastMode, SessionsPatchResult } from "../../api/types.ts";

export type SessionToolOverrides = {
  mcpServers?: Record<string, boolean>;
  mcpToolsDeny?: Record<string, string[]>;
  skills?: Record<string, boolean>;
  webSearch?: boolean;
};

/**
 * Row presentation the operator owns and can see. Identity rotates underneath a
 * row routinely (compaction alone does it mid-run), so these mutations follow the
 * row, not the generation. Lifecycle fields are absent on purpose: archiving
 * guards its own generation, and that is an invariant, not a label.
 */
const SESSION_PRESENTATION_PATCH_KEYS: ReadonlySet<string> = new Set([
  "boardFace",
  "category",
  "icon",
  "label",
  "pinned",
  "unread",
]);

/** True when every field in this patch is row presentation, so intent survives a rotation. */
export function isSessionPresentationPatch(patch: SessionPatch): boolean {
  const fields = Object.keys(patch).filter((field) => field !== "expectedSessionId");
  return fields.length > 0 && fields.every((field) => SESSION_PRESENTATION_PATCH_KEYS.has(field));
}

/**
 * Reads the Gateway's refusal of a patch whose target moved; `null` for anything
 * else. `currentSessionId` present means the row survived a rotation, absent
 * means the entry is gone.
 */
export function readSessionChangedTarget(error: unknown): { currentSessionId?: string } | null {
  const shape = asNullableRecord(error);
  const details = asNullableRecord(shape?.details);
  if (
    details?.code !== GatewayErrorDetailCodes.SESSION_CHANGED ||
    (shape?.gatewayCode !== ErrorCodes.INVALID_REQUEST &&
      shape?.code !== ErrorCodes.INVALID_REQUEST)
  ) {
    return null;
  }
  const currentSessionId = details.currentSessionId;
  return typeof currentSessionId === "string" && currentSessionId.length > 0
    ? { currentSessionId }
    : {};
}

export type SessionPatch = {
  /**
   * Identity of the row the operator acted on, captured when they acted, so a
   * mutation started before a replacement cannot land on a session they never
   * chose or recreate one that is gone.
   */
  expectedSessionId?: string;
  label?: string | null;
  category?: string | null;
  boardFace?: "chat" | "dashboard";
  model?: string | null;
  thinkingLevel?: string | null;
  fastMode?: FastMode | null;
  verboseLevel?: string | null;
  reasoningLevel?: string | null;
  toolOverrides?: SessionToolOverrides | null;
  archived?: boolean;
  pinned?: boolean;
  unread?: boolean;
};

export type SessionPatchOptions = {
  agentId?: string;
  /** Let a caller with stricter lifecycle ownership publish the resolved model value. */
  deferModelOverride?: boolean;
  /** Keep optimistic model state bound to the UI owner that initiated the patch. */
  ownsModelOverride?: () => boolean;
  /** Capture the current connection now, but dispatch only after this tail settles. */
  waitFor?: Promise<unknown>;
  /**
   * Skips the canonical list refresh this patch forces. Batch callers own one
   * refresh after their last row; otherwise an N-row batch pays N full
   * `sessions.list` round trips while `sessions.changed` already reconciles.
   */
  deferListRefresh?: boolean;
};

export type SessionPatchRoute = (
  key: string,
  patch: SessionPatch,
  options?: SessionPatchOptions,
) => Promise<SessionsPatchResult | null>;
