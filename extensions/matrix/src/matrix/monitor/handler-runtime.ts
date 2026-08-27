import { createLazyRuntimeModule } from "afora-agent/plugin-sdk/lazy-runtime";
import type { MatrixClient } from "../sdk.js";
import { MATRIX_AFORA_FINALIZED_PREVIEW_KEY } from "../send/types.js";

export type MatrixDraftStreamHandle = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  stop: () => Promise<string | undefined>;
  discardPending: () => Promise<void>;
  eventId: () => string | undefined;
  content: () => string | undefined;
  mustDeliverFinalNormally: () => boolean;
  matchesPreparedText: (text: string) => boolean;
  finalizeLive: () => Promise<boolean>;
  reset: () => void;
};

export async function redactMatrixDraftEvent(
  client: MatrixClient,
  roomId: string,
  draftEventId: string,
): Promise<boolean> {
  return await client.redactEvent(roomId, draftEventId).then(
    () => true,
    () => false,
  );
}

export function buildMatrixFinalizedPreviewContent(): Record<string, unknown> {
  return { [MATRIX_AFORA_FINALIZED_PREVIEW_KEY]: true };
}

export const loadMatrixSendModule = createLazyRuntimeModule(() => import("../send.js"));

export const loadAcpBindingRuntime = createLazyRuntimeModule(
  () => import("afora-agent/plugin-sdk/acp-binding-runtime"),
);

export const loadSessionBindingRuntime = createLazyRuntimeModule(
  () => import("afora-agent/plugin-sdk/session-binding-runtime"),
);

export const loadMatrixReactionEvents = createLazyRuntimeModule(
  () => import("./reaction-events.js"),
);

export const loadMatrixDraftStream = createLazyRuntimeModule(() => import("../draft-stream.js"));

export async function matrixTextWouldActivateMentions(
  client: MatrixClient,
  text: string,
): Promise<boolean> {
  const { resolveMatrixMentionsForBody } = await loadMatrixSendModule();
  const mentions = await resolveMatrixMentionsForBody({ client, body: text });
  return mentions.room === true || (mentions.user_ids?.length ?? 0) > 0;
}
