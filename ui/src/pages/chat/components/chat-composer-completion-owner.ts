import { resetSkillMenuState, updateSkillMenu } from "./chat-composer-skill-menu.ts";
import { resetSlashMenuState, updateSlashMenu } from "./chat-composer-slash-menu.ts";
import { getChatComposerState } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function syncChatComposerCompletionOwner(params: {
  draftKey: string;
  props: ChatComposerProps;
  requestUpdate: () => void;
  state: ChatComposerState;
}): void {
  const { draftKey, props, requestUpdate, state } = params;
  const previousDraftKey = state.completionDraftKey;
  const gatewayClient = props.gatewayClient ?? null;
  const ownerChanged =
    previousDraftKey !== draftKey || state.completionGatewayClient !== gatewayClient;
  state.completionDraftKey = draftKey;
  state.completionGatewayClient = gatewayClient;
  if (!ownerChanged) {
    return;
  }

  if (previousDraftKey === null) {
    return;
  }
  resetSlashMenuState(state);
  resetSkillMenuState(state);
  queueMicrotask(() => {
    const currentState = getChatComposerState(props.paneId);
    if (
      currentState.completionDraftKey !== draftKey ||
      currentState.completionGatewayClient !== gatewayClient
    ) {
      return;
    }
    const currentDraft = props.getDraft?.() ?? props.draft;
    const currentCaret = currentState.composerTextarea?.selectionStart ?? currentDraft.length;
    updateSlashMenu(
      currentDraft,
      requestUpdate,
      props,
      {},
      () => props.getDraft?.() ?? props.draft,
    );
    updateSkillMenu(
      currentDraft,
      currentCaret,
      requestUpdate,
      props,
      {},
      () => props.getDraft?.() ?? props.draft,
      () => currentState.composerTextarea?.selectionStart ?? currentDraft.length,
    );
  });
}
